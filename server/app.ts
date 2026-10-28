import Fastify, { type FastifyBaseLogger, type FastifyRequest } from "fastify";
import multipart from "@fastify/multipart";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { fromNodeHeaders } from "better-auth/node";
import { randomUUID, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { eq, and, isNull, desc, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { sendSecurityMail } from "./mail.js";
import { emailHtml } from "./email-design.js";
import { auth } from "./auth.js";
import { config, emailEnabled } from "./config.js";
import { db } from "./db.js";
import {
  user,
  signatures,
  documents,
  invitations,
  exportsTable,
  audit,
  evidenceRecords,
} from "./schema.js";
import {
  normalizeSignature,
  storeFile,
  loadFile,
  removeFile,
  sha256,
  seal,
  unseal,
} from "./storage.js";
import { inspectPdf, renderPdf } from "./pdf.js";
import { queue } from "./queue.js";
import { registerAdminRoutes } from "./admin.js";
import {
  registerAccountSecurityRoutes,
  requireAccountVerification,
} from "./account-security.js";
import {
  registerDocumentLifecycleRoutes,
  recordOwnerAcceptance,
} from "./document-lifecycle.js";
import { assertStorageBudget, assertExportBudget } from "./storage-usage.js";
import { registerRecipientRecordRoutes } from "./recipient-records.js";
import {
  authenticateApiKey,
  recordApiKeyRequest,
  registerApiKeyRoutes,
} from "./api-keys.js";
import type {
  Placement,
  FrozenPlacement,
  PageInfo,
  SignaturePlacement,
  TextPlacement,
  SigningField,
  StoredSigningField,
  RecipientTextValue,
} from "../shared/types.js";
import { fitPdfText, normalizePdfText } from "../shared/pdf-text.js";
import { SIGNING_CONSENT } from "../shared/signing-consent.js";
import {
  verificationStatus,
  sendVerificationCode,
  confirmVerificationCode,
  requireVerifiedMailbox,
  consumeSignerVerification,
  type VerificationContext,
} from "./signer-verification.js";
import {
  retainReview,
  recordAcceptance,
  verifiedEvidenceFile,
  ensureCanonicalExport,
} from "./evidence.js";

const idSchema = z.string().uuid();
const fieldSchema = z
  .object({
    id: idSchema,
    pageIndex: z.number().int().min(0),
    x: z.number().finite().min(0).max(1),
    y: z.number().finite().min(0).max(1),
    width: z.number().finite().min(0.01).max(1),
    height: z.number().finite().min(0.002).max(1),
  })
  .refine(
    (p) => p.x + p.width <= 1.00001 && p.y + p.height <= 1.00001,
    "Keep the field inside the page.",
  );
const textValueSchema = z
  .string()
  .max(400)
  .transform((value, context) => {
    try {
      return normalizePdfText(value);
    } catch (error) {
      context.addIssue({ code: "custom", message: (error as Error).message });
      return z.NEVER;
    }
  });
const fontSizeSchema = z.number().finite().min(6).max(36);
const placementSchema = z.discriminatedUnion("kind", [
  fieldSchema.safeExtend({
    kind: z.literal("signature").optional(),
    signatureId: idSchema,
  }),
  fieldSchema.safeExtend({
    kind: z.literal("text"),
    text: textValueSchema,
    fontSize: fontSizeSchema,
  }),
]);
const recipientTextFieldSchema = fieldSchema.safeExtend({
  label: z.string().trim().min(1).max(80),
  fontSize: fontSizeSchema,
});
const pngSchema = z.string().max(3_000_000);
const fail = (statusCode: number, message: string): never => {
  throw Object.assign(new Error(message), { statusCode, publicError: true });
};
const getId = (req: FastifyRequest, field = "id") =>
  idSchema.parse((req.params as Record<string, string>)[field]);
const publicSignature = (s: typeof signatures.$inferSelect) => ({
  id: s.id,
  name: s.name,
  source: s.source,
  width: s.width,
  height: s.height,
  isDefault: s.isDefault,
  createdAt: s.createdAt,
});
const publicDocument = (d: typeof documents.$inferSelect) => ({
  id: d.id,
  name: d.name,
  byteSize: d.byteSize,
  pages: d.pages,
  placements: d.placements,
  status: d.status,
  revision: d.revision,
  createdAt: d.createdAt,
  updatedAt: d.updatedAt,
});
function validateFields(
  fields: Array<{ pageIndex: number }>,
  pages: PageInfo[],
) {
  if (fields.some((f) => f.pageIndex >= pages.length))
    fail(400, "That page does not exist.");
}
function validateTextLayers(layers: TextPlacement[], pages: PageInfo[]) {
  for (const layer of layers) {
    const page = pages[layer.pageIndex];
    try {
      fitPdfText(
        layer.text,
        layer.fontSize,
        layer.width * page.width,
        layer.height * page.height,
      );
    } catch (error) {
      fail(400, (error as Error).message);
    }
  }
}
function signatureField(field: StoredSigningField): SigningField {
  const { textFields: _fields, textValues: _values, ...geometry } = field;
  return geometry;
}
function textLayers(
  field: StoredSigningField,
  values: RecipientTextValue[] = field.textValues ?? [],
): TextPlacement[] {
  return (field.textFields ?? []).map(({ label: _label, ...geometry }) => ({
    ...geometry,
    kind: "text",
    text: values.find((value) => value.id === geometry.id)?.text ?? "",
  }));
}
function validateTextValues(
  field: StoredSigningField,
  values: RecipientTextValue[],
  pages: PageInfo[],
): RecipientTextValue[] {
  const fields = field.textFields ?? [];
  if (
    values.length !== fields.length ||
    new Set(values.map((value) => value.id)).size !== values.length ||
    values.some((value) => !fields.some((field) => field.id === value.id))
  )
    fail(400, "Fill in each assigned text field exactly once.");
  validateTextLayers(textLayers(field, values), pages);
  // Stable field order binds the audit hash to the exact values rendered later.
  return fields.map((field) => values.find((value) => value.id === field.id)!);
}
async function actor(req: FastifyRequest) {
  if (req.apiKey) return req.apiKey.user;
  const s = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  });
  return s?.user ?? fail(401, "Sign in to continue.");
}
type Reader = Pick<typeof db, "select" | "query">;
async function ownerDoc(id: string, owner: string, reader: Reader = db) {
  return (
    (await reader.query.documents.findFirst({
      where: and(
        eq(documents.id, id),
        eq(documents.userId, owner),
        isNull(documents.deletedAt),
      ),
    })) ?? fail(404, "Document not found.")
  );
}
async function freeze(
  owner: string,
  placements: Placement[],
  reader: Reader = db,
): Promise<FrozenPlacement[]> {
  if (!placements.length) return [];
  const imagePlacements = placements.filter(
    (placement): placement is SignaturePlacement => placement.kind !== "text",
  );
  const images = imagePlacements.length
    ? await reader
        .select()
        .from(signatures)
        .where(
          and(
            eq(signatures.userId, owner),
            inArray(
              signatures.id,
              imagePlacements.map((p) => p.signatureId),
            ),
          ),
        )
    : [];
  return placements.map((placement) => {
    if (placement.kind === "text") return { ...placement };
    const { signatureId, ...p } = placement;
    return {
      ...p,
      imageKey:
        images.find((s) => s.id === signatureId)?.fileKey ??
        fail(
          400,
          "A selected signature is unavailable. Choose another signature.",
        ),
    };
  });
}
type InvitationRow = typeof invitations.$inferSelect;
async function documentInvitations(documentId: string, reader: Reader = db) {
  return reader
    .select()
    .from(invitations)
    .where(eq(invitations.documentId, documentId))
    .orderBy(invitations.signingOrder);
}
function signingProgress(
  invitation: InvitationRow,
  recipients: InvitationRow[],
) {
  const waitingForSigners = recipients.filter(
    (r) => r.signingOrder < invitation.signingOrder && r.state === "pending",
  ).length;
  const signingStatus =
    invitation.state === "signed"
      ? "signed"
      : invitation.state === "revoked"
        ? "revoked"
        : invitation.expiresAt <= new Date()
          ? "expired"
          : waitingForSigners
            ? "waiting"
            : "ready";
  return {
    signingOrder: invitation.signingOrder,
    signingStatus,
    canSign: signingStatus === "ready",
    waitingForSigners,
  };
}
function publicInvitation(
  invitation: InvitationRow,
  recipients: InvitationRow[],
) {
  return {
    id: invitation.id,
    name: invitation.name,
    email: invitation.email,
    field: signatureField(invitation.field),
    textFields: invitation.field.textFields ?? [],
    state: invitation.state,
    expiresAt: invitation.expiresAt,
    signedAt: invitation.signedAt,
    url: `${config.APP_URL}/sign/${unseal(invitation.sealedToken)}`,
    ...signingProgress(invitation, recipients),
  };
}
async function recipient(
  req: FastifyRequest,
  reader: Reader = db,
  allowSignedExpired = false,
) {
  const token = z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/)
    .parse((req.params as { token: string }).token);
  const invitation = await reader.query.invitations.findFirst({
    where: eq(invitations.tokenHash, sha256(token)),
  });
  if (
    !invitation ||
    invitation.state === "revoked" ||
    (invitation.expiresAt <= new Date() &&
      !(allowSignedExpired && invitation.state === "signed"))
  )
    fail(
      404,
      "This signing link is unavailable or has expired. Ask the sender for a new link.",
    );
  const document = await reader.query.documents.findFirst({
    where: eq(documents.id, invitation!.documentId),
  });
  if (!document) fail(404, "Document not found.");
  return { invitation: invitation!, document: document!, token };
}
async function signingSnapshot(
  req: FastifyRequest,
  allowSignedExpired = false,
) {
  const initial = await recipient(req, db, allowSignedExpired);
  return db.transaction(async (tx) => {
    // Every signing mutation takes this same lock before reading invitation rows.
    await tx.execute(
      sql`select id from document where id = ${initial.document.id} for update`,
    );
    const current = await recipient(req, tx, allowSignedExpired);
    const recipients = await documentInvitations(current.document.id, tx);
    return {
      ...current,
      recipients,
      ...signingProgress(current.invitation, recipients),
    };
  });
}
async function allLayers(
  document: typeof documents.$inferSelect,
  reader: Reader = db,
) {
  const layers = await freeze(document.userId, document.placements, reader);
  const completed = await reader
    .select()
    .from(invitations)
    .where(
      and(
        eq(invitations.documentId, document.id),
        eq(invitations.state, "signed"),
      ),
    )
    .orderBy(invitations.signingOrder);
  return layers.concat(completed.flatMap(signedLayers));
}
function signedLayers(invitation: InvitationRow): FrozenPlacement[] {
  return [
    { ...signatureField(invitation.field), imageKey: invitation.imageKey! },
    ...textLayers(invitation.field),
  ];
}
function signingLinkText(invitation: InvitationRow) {
  const url = `${config.APP_URL}/sign/${unseal(invitation.sealedToken)}`;
  return {
    url,
    text: `Open your private signing link:\n${url}\n\nThis link expires on ${invitation.expiresAt.toISOString().slice(0, 10)}. You can upload or draw your signature.\n\nPaperSign`,
  };
}
function mailPreview(
  invitation: InvitationRow,
  doc: typeof documents.$inferSelect,
  senderName: string,
  recipients: InvitationRow[],
) {
  const link = signingLinkText(invitation);
  const turn = signingProgress(invitation, recipients).canSign
    ? "You can sign it now."
    : `You are signer ${invitation.signingOrder} in the signing order. Your turn opens once the earlier signers have finished${emailEnabled ? ", and PaperSign will email you when it does" : ""}.`;
  const body = `Hello ${invitation.name},\n\n${senderName} has invited you to sign “${doc.name}”. ${turn}\n\n${link.text}`;
  return {
    to: invitation.email,
    subject: `${senderName} invited you to sign ${doc.name}`,
    body,
    html: emailHtml(body, {
      heading: "You’re invited to sign",
      preview: `${senderName} invited you to sign ${doc.name}.`,
      action: { label: "Review document", url: link.url },
    }),
    attachments: [],
  };
}
function turnMail(
  invitation: InvitationRow,
  doc: typeof documents.$inferSelect,
  senderName: string,
) {
  const link = signingLinkText(invitation);
  const body = `Hello ${invitation.name},\n\nThe earlier signers have finished, so you can now sign “${doc.name}” from ${senderName}.\n\n${link.text}`;
  return {
    to: invitation.email,
    subject: `Your turn to sign ${doc.name}`,
    text: body,
    html: emailHtml(body, {
      heading: "It’s your turn to sign",
      preview: `You can now sign ${doc.name}.`,
      action: { label: "Review document", url: link.url },
    }),
  };
}
/** Requests that could not be signed before a change and can be signed after it. */
function newTurns(before: InvitationRow[], after: InvitationRow[]) {
  const readyBefore = new Set(
    before.filter((r) => signingProgress(r, before).canSign).map((r) => r.id),
  );
  return after.filter(
    (r) => !readyBefore.has(r.id) && signingProgress(r, after).canSign,
  );
}
/**
 * Emails each signer whose turn opened because an earlier request was signed or revoked.
 * Callers work out `due` inside the transaction that made the change and call this
 * after it commits, so a failure never undoes that change. The outcome is kept in
 * the document history.
 */
async function emailNewTurns(
  documentId: string,
  due: InvitationRow[],
  actorId: string,
  log: FastifyBaseLogger,
) {
  if (!emailEnabled || !due.length) return;
  const doc = await db.query.documents.findFirst({
    where: eq(documents.id, documentId),
  });
  if (!doc || doc.status !== "awaiting" || doc.deletedAt) return;
  const owner = await db.query.user.findFirst({
    where: eq(user.id, doc.userId),
  });
  for (const invitation of due) {
    let event = "turn_email_sent";
    try {
      await sendSecurityMail(
        turnMail(invitation, doc, owner?.name ?? "The sender"),
      );
    } catch {
      event = "turn_email_failed";
      log.warn(
        { documentId, invitationId: invitation.id },
        "Could not email the next signer",
      );
    }
    await db.insert(audit).values({
      id: randomUUID(),
      documentId,
      actor: actorId,
      event,
      details: {
        invitationId: invitation.id,
        signingOrder: invitation.signingOrder,
      },
    });
  }
}
function emailNewTurnsLater(
  documentId: string,
  due: InvitationRow[],
  actorId: string,
  log: FastifyBaseLogger,
) {
  void emailNewTurns(documentId, due, actorId, log).catch(() =>
    log.warn({ documentId }, "Could not check for the next signer's turn"),
  );
}

export async function buildApp() {
  const app = Fastify({
    bodyLimit: 3_200_000,
    trustProxy: config.TRUSTED_PROXY?.split(",").map((s) => s.trim()) ?? false,
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      serializers: {
        req: (req: { method: string; url: string }) => ({
          method: req.method,
          url: req.url
            .split("?")[0]
            .replace(/(\/auth\/reset-password\/)[^/]+/g, "$1[redacted]")
            .replace(
              /(\/(?:sign|join|account-invitations)\/)[^/?]+/g,
              "$1[redacted]",
            ),
        }),
      },
      redact: ["req.headers.cookie", "req.headers.authorization"],
    },
  });
  await app.register(multipart, {
    limits: { fileSize: 25 * 1024 * 1024, files: 1, fields: 0 },
  });
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
        workerSrc: ["'self'", "blob:"],
        imgSrc: ["'self'", "blob:", "data:"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        upgradeInsecureRequests: config.APP_URL.startsWith("https:")
          ? []
          : null,
      },
    },
    referrerPolicy: { policy: "no-referrer" },
    crossOriginEmbedderPolicy: false,
  });
  await app.register(rateLimit, {
    max: 180,
    timeWindow: "1 minute",
    // Only the API is limited. Page files are static, and counting them let a
    // busy office behind one address receive a blank page.
    allowList: (req) => !req.url.startsWith("/api/"),
  });
  app.decorateRequest("apiKey", null);
  app.addHook("onRequest", async (req, reply) => {
    if (req.url.startsWith("/api/"))
      reply.header("Cache-Control", "private, no-store");
    // A bearer key is never attached by a browser on its own, so key requests
    // skip the cross-site checks below. Invalid keys are refused here.
    if (await authenticateApiKey(req)) return;
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      !req.url.startsWith("/api/auth/")
    ) {
      if (
        req.headers.origin !== config.APP_URL ||
        req.headers["x-papersign"] !== "1"
      )
        fail(
          403,
          "The request could not be verified. Reload the page and try again.",
        );
    }
  });
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof z.ZodError)
      return reply.status(400).send({
        message: error.issues[0]?.message ?? "Check the supplied values.",
      });
    const err = error as Error & {
      statusCode?: number;
      code?: string;
      publicError?: boolean;
    };
    if (err.statusCode && (err.statusCode < 500 || err.publicError))
      return reply.status(err.statusCode).send({ message: err.message });
    req.log.error({ error: err.message }, "Request failed");
    return reply
      .status(500)
      .send({ message: "Something went wrong. Try again in a moment." });
  });
  app.get("/api/health", async () => {
    await db.execute(sql`select 1`);
    return { status: "ok" };
  });
  app.get("/api/config", async () => ({
    certificateSealingEnabled: Boolean(config.SEAL_POLICY_ID),
    emailEnabled,
    emailTestSink:
      ["localhost", "127.0.0.1", "::1"].includes(config.SMTP_HOST ?? "") &&
      config.SMTP_PORT === 2526 &&
      /@example\.(invalid|test)>?$/.test(config.SMTP_FROM ?? ""),
    registrationEnabled: config.REGISTRATION_ENABLED === "true",
  }));
  app.addHook("onResponse", recordApiKeyRequest);
  await registerAdminRoutes(app);
  await registerApiKeyRoutes(app);
  await registerAccountSecurityRoutes(app);
  await registerDocumentLifecycleRoutes(app, {
    actor,
    allLayers,
    publicDocument,
  });
  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    handler: async (req, reply) => {
      const headers = fromNodeHeaders(req.headers);
      headers.set("x-papersign-client-ip", req.ip);
      const response = await auth.handler(
        new Request(new URL(req.url, config.APP_URL), {
          method: req.method,
          headers,
          ...(req.body ? { body: JSON.stringify(req.body) } : {}),
        }),
      );
      response.headers.forEach((value, key) => {
        if (key !== "set-cookie") reply.header(key, value);
      });
      if (response.headers.getSetCookie().length)
        reply.header("set-cookie", response.headers.getSetCookie());
      return reply.status(response.status).send(await response.text());
    },
  });

  app.get("/api/signatures", async (req) => {
    const u = await actor(req);
    return (
      await db
        .select()
        .from(signatures)
        .where(and(eq(signatures.userId, u.id), isNull(signatures.deletedAt)))
        .orderBy(desc(signatures.isDefault), desc(signatures.createdAt))
    ).map(publicSignature);
  });
  app.post(
    "/api/signatures",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const u = await actor(req);
      const body = z
        .object({
          name: z.string().trim().min(1).max(80),
          source: z.enum(["uploaded", "drawn"]),
          png: pngSchema,
        })
        .parse(req.body);
      const normalized = await normalizeSignature(body.png).catch((e) =>
        fail(
          400,
          e.statusCode === 400
            ? e.message
            : "This PNG could not be read. Choose another signature image.",
        ),
      );
      const fileKey = await storeFile(normalized.bytes, "png");
      try {
        const record = await db.transaction(async (tx) => {
          await tx.execute(
            sql`select id from "user" where id = ${u.id} for update`,
          );
          await assertStorageBudget(u.id, normalized.bytes.length, tx);
          const current = await tx
            .select()
            .from(signatures)
            .where(
              and(eq(signatures.userId, u.id), isNull(signatures.deletedAt)),
            );
          if (current.length >= 20)
            fail(
              400,
              "You can save up to 20 signatures. Remove one before adding another.",
            );
          return (
            await tx
              .insert(signatures)
              .values({
                id: randomUUID(),
                userId: u.id,
                name: body.name,
                source: body.source,
                fileKey,
                width: normalized.width,
                height: normalized.height,
                isDefault: current.length === 0,
              })
              .returning()
          )[0];
        });
        return reply.status(201).send(publicSignature(record));
      } catch (error) {
        await removeFile(fileKey);
        throw error;
      }
    },
  );
  app.get("/api/signatures/:id/image", async (req, reply) => {
    const u = await actor(req),
      id = getId(req);
    const record = await db.query.signatures.findFirst({
      where: and(eq(signatures.id, id), eq(signatures.userId, u.id)),
    });
    if (!record) fail(404, "Signature not found.");
    return reply.type("image/png").send(await loadFile(record!.fileKey));
  });
  app.patch("/api/signatures/:id", async (req) => {
    const u = await actor(req),
      id = getId(req);
    const body = z
      .object({
        name: z.string().trim().min(1).max(80).optional(),
        isDefault: z.literal(true).optional(),
      })
      .parse(req.body);
    return db.transaction(async (tx) => {
      await tx.execute(
        sql`select id from "user" where id = ${u.id} for update`,
      );
      const [record] = await tx
        .select()
        .from(signatures)
        .where(
          and(
            eq(signatures.id, id),
            eq(signatures.userId, u.id),
            isNull(signatures.deletedAt),
          ),
        );
      if (!record) fail(404, "Signature not found.");
      if (body.isDefault)
        await tx
          .update(signatures)
          .set({ isDefault: false })
          .where(eq(signatures.userId, u.id));
      return publicSignature(
        (
          await tx
            .update(signatures)
            .set(body)
            .where(eq(signatures.id, id))
            .returning()
        )[0],
      );
    });
  });
  app.delete("/api/signatures/:id", async (req, reply) => {
    const u = await actor(req),
      id = getId(req);
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`select id from "user" where id = ${u.id} for update`,
      );
      const [record] = await tx
        .update(signatures)
        .set({ deletedAt: new Date(), isDefault: false })
        .where(
          and(
            eq(signatures.id, id),
            eq(signatures.userId, u.id),
            isNull(signatures.deletedAt),
          ),
        )
        .returning();
      if (!record) fail(404, "Signature not found.");
      const remaining = await tx
        .select()
        .from(signatures)
        .where(and(eq(signatures.userId, u.id), isNull(signatures.deletedAt)))
        .orderBy(desc(signatures.createdAt));
      if (remaining.length && !remaining.some((s) => s.isDefault))
        await tx
          .update(signatures)
          .set({ isDefault: true })
          .where(eq(signatures.id, remaining[0].id));
    });
    return reply.status(204).send();
  });

  app.get("/api/documents", async (req) => {
    const u = await actor(req);
    return (
      await db
        .select()
        .from(documents)
        .where(and(eq(documents.userId, u.id), isNull(documents.deletedAt)))
        .orderBy(desc(documents.updatedAt))
        .limit(200)
    ).map(publicDocument);
  });
  app.post(
    "/api/documents",
    { config: { rateLimit: { max: 15, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const u = await actor(req),
        upload = await req.file();
      if (!upload) fail(400, "Choose a PDF to upload.");
      const bytes = await upload!.toBuffer();
      if (upload!.file.truncated) fail(413, "Choose a PDF smaller than 25 MB.");
      if (!bytes.subarray(0, 1024).includes(Buffer.from("%PDF-")))
        fail(400, "Choose a valid PDF file.");
      const fileKey = await storeFile(bytes, "pdf");
      try {
        const pages = await inspectPdf(fileKey).catch((error) =>
          fail(400, error.message),
        );
        const filename =
          upload!.filename
            .replace(/[\x00-\x1f/\\]/g, "")
            .slice(0, 160)
            .trim() || "Document.pdf";
        const record = await db.transaction(async (tx) => {
          await tx.execute(
            sql`select id from "user" where id = ${u.id} for update`,
          );
          const [usage] = await tx
            .select({
              count: sql<number>`count(*)::int`,
              bytes: sql<number>`coalesce(sum(byte_size), 0)::bigint`,
            })
            .from(documents)
            .where(eq(documents.userId, u.id));
          await assertStorageBudget(u.id, bytes.length, tx);
          if (usage.count >= 200)
            fail(
              413,
              "Your account has reached its limit of 200 retained documents.",
            );
          return (
            await tx
              .insert(documents)
              .values({
                id: randomUUID(),
                userId: u.id,
                name: filename,
                fileKey,
                sourceHash: sha256(bytes),
                byteSize: bytes.length,
                pages,
              })
              .returning()
          )[0];
        });
        return reply.status(201).send(publicDocument(record));
      } catch (error) {
        await removeFile(fileKey);
        throw error;
      }
    },
  );
  app.get("/api/documents/:id", async (req) => {
    const u = await actor(req),
      document = await ownerDoc(getId(req), u.id);
    const recipients = await documentInvitations(document.id);
    return {
      ...publicDocument(document),
      invitations: recipients.map((r) => publicInvitation(r, recipients)),
    };
  });
  app.get("/api/documents/:id/pdf", async (req, reply) => {
    const u = await actor(req),
      document = await ownerDoc(getId(req), u.id);
    return reply.type("application/pdf").send(await loadFile(document.fileKey));
  });
  app.put("/api/documents/:id/placements", async (req) => {
    const u = await actor(req),
      id = getId(req);
    const body = z
      .object({
        revision: z.number().int(),
        placements: z.array(placementSchema).max(100),
      })
      .parse(req.body);
    if (req.apiKey && body.placements.some((p) => p.kind !== "text"))
      fail(
        403,
        "API keys can add text only. Signers sign through their signing links.",
      );
    const document = await ownerDoc(id, u.id);
    validateFields(body.placements, document.pages);
    validateTextLayers(
      body.placements.filter((p): p is TextPlacement => p.kind === "text"),
      document.pages,
    );
    if (
      new Set(body.placements.map((p) => p.id)).size !== body.placements.length
    )
      fail(400, "Document fields must have unique IDs.");
    await freeze(u.id, body.placements);
    const [updated] = await db
      .update(documents)
      .set({
        placements: body.placements,
        revision: document.revision + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(documents.id, id),
          eq(documents.userId, u.id),
          eq(documents.revision, body.revision),
          eq(documents.status, "draft"),
        ),
      )
      .returning();
    if (!updated)
      fail(
        409,
        "This document changed or has been sent for signing. Reload it before continuing.",
      );
    return publicDocument(updated);
  });
  app.post(
    "/api/documents/:id/exports",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const u = await actor(req),
        id = getId(req);
      const body = z
        .object({ rasterize: z.boolean(), revision: z.number().int() })
        .parse(req.body);
      const record = await db.transaction(async (tx) => {
        await tx.execute(
          sql`select id from document where id = ${id} and user_id = ${u.id} for update`,
        );
        const document = await ownerDoc(id, u.id, tx);
        if (document.revision !== body.revision)
          fail(409, "Save or reload the document before exporting.");
        if (document.status === "awaiting")
          fail(
            409,
            "Wait for the requested signatures before downloading the completed PDF.",
          );
        if (
          document.status === "draft" &&
          document.placements.some((placement) => placement.kind !== "text")
        )
          fail(
            409,
            "Review and sign this document before preparing its completed download.",
          );
        const existing = await tx.query.exportsTable.findFirst({
          where: and(
            eq(exportsTable.documentId, id),
            eq(exportsTable.revision, document.revision),
            eq(exportsTable.rasterize, body.rasterize),
            eq(exportsTable.sealPolicyId, config.SEAL_POLICY_ID ?? ""),
            inArray(exportsTable.state, ["queued", "working", "ready"]),
          ),
          orderBy: desc(exportsTable.createdAt),
        });
        if (existing) return existing;
        await tx.execute(
          sql`select id from "user" where id = ${u.id} for update`,
        );
        await assertExportBudget(u.id, tx);
        const [usage] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(exportsTable)
          .where(eq(exportsTable.documentId, id));
        if (usage.count >= 30)
          fail(
            429,
            "This document has reached its limit of 30 exports. Upload a new copy to continue.",
          );
        const layers = await allLayers(document, tx);
        const sourceFiles = await Promise.all(
          [
            ...new Set([
              document.fileKey,
              ...layers
                .filter((layer) => layer.kind !== "text")
                .map((layer) => layer.imageKey),
            ]),
          ].map(async (fileKey, index) => {
            const bytes = await loadFile(fileKey);
            return {
              name: `render-source-${index}`,
              fileKey,
              sha256: sha256(bytes),
              size: bytes.length,
            };
          }),
        );
        return (
          await tx
            .insert(exportsTable)
            .values({
              id: randomUUID(),
              documentId: id,
              revision: document.revision,
              rasterize: body.rasterize,
              sealPolicyId: config.SEAL_POLICY_ID ?? "",
              originalKey: document.fileKey,
              layers,
              sourceFiles,
            })
            .returning()
        )[0];
      });
      if (record.state === "queued")
        await queue
          .send(
            "pdf-export",
            { exportId: record.id },
            { singletonKey: record.id },
          )
          .catch((error) =>
            req.log.error(
              { message: error.message },
              "Export stored; worker will enqueue it",
            ),
          );
      return reply.status(202).send({
        id: record.id,
        state: record.state,
        rasterize: record.rasterize,
        sealPolicyId: record.sealPolicyId,
        seal: record.seal,
      });
    },
  );
  app.get("/api/exports/:id", async (req) => {
    const u = await actor(req),
      id = getId(req),
      record = await db.query.exportsTable.findFirst({
        where: eq(exportsTable.id, id),
      });
    if (!record) fail(404, "Export not found.");
    await ownerDoc(record!.documentId, u.id);
    return {
      id: record!.id,
      state: record!.state,
      rasterize: record!.rasterize,
      error: record!.error,
      sealPolicyId: record!.sealPolicyId,
      seal: record!.seal,
    };
  });
  app.get("/api/exports/:id/download", async (req, reply) => {
    const u = await actor(req),
      record = await db.query.exportsTable.findFirst({
        where: eq(exportsTable.id, getId(req)),
      });
    if (!record) fail(404, "Export not found.");
    const doc = await ownerDoc(record!.documentId, u.id);
    if (record!.state !== "ready" || !record!.fileKey)
      fail(409, "This PDF is still being prepared.");
    return reply
      .header(
        "Content-Disposition",
        `attachment; filename="signed.pdf"; filename*=UTF-8''${encodeURIComponent(doc.name.replace(/\.pdf$/i, "") + "-signed" + (record!.rasterize ? "-rasterized" : "") + ".pdf")}`,
      )
      .type("application/pdf")
      .send(await verifiedEvidenceFile(record!.fileKey!, record!.sha256!));
  });

  app.post("/api/documents/:id/invitations", async (req, reply) => {
    const u = await actor(req),
      id = getId(req);
    requireAccountVerification(u);
    const body = z
      .object({
        revision: z.number().int(),
        termsLocked: z.literal(true),
        ownerReviewId: z.string().uuid().optional(),
        ownerConsentVersion: z.string().optional(),
        recipients: z
          .array(
            z.object({
              name: z.string().trim().min(1).max(100),
              email: z.string().trim().email().max(254),
              field: fieldSchema,
              textFields: z.array(recipientTextFieldSchema).max(10).default([]),
            }),
          )
          .min(1)
          .max(10),
      })
      .parse(req.body);
    const document = await ownerDoc(id, u.id);
    if (document.status !== "draft" || document.revision !== body.revision)
      fail(409, "This document has changed or is already awaiting signatures.");
    if (
      new Set(body.recipients.map((r) => r.email.toLowerCase())).size !==
      body.recipients.length
    )
      fail(400, "Each signer must have a different email address.");
    const fields = body.recipients.flatMap((r) => [r.field, ...r.textFields]);
    if (new Set(fields.map((field) => field.id)).size !== fields.length)
      fail(400, "Signing and text fields must have unique IDs.");
    validateFields(fields, document.pages);
    validateTextLayers(
      body.recipients.flatMap((r) =>
        r.textFields.map((field) => ({
          ...field,
          kind: "text" as const,
          text: "X",
        })),
      ),
      document.pages,
    );
    const ownerLayers = await freeze(u.id, document.placements);
    const ownerIsSigning = ownerLayers.some((layer) => layer.kind !== "text");
    // Accepting the owner's own signature is a consent act for the browser.
    if (req.apiKey && ownerIsSigning)
      fail(
        403,
        "This document has your signature on it. Send it for signing in the browser.",
      );
    if (
      ownerIsSigning &&
      (!body.ownerReviewId ||
        body.ownerConsentVersion !== SIGNING_CONSENT.version)
    )
      fail(
        400,
        "Review and accept your own signature before creating invitations.",
      );
    const ownerReview = ownerIsSigning
      ? await db.query.evidenceRecords.findFirst({
          where: and(
            eq(evidenceRecords.id, body.ownerReviewId!),
            eq(evidenceRecords.documentId, id),
            eq(evidenceRecords.actor, `owner:${u.id}`),
            eq(evidenceRecords.kind, "review"),
            eq(evidenceRecords.revision, document.revision),
          ),
        })
      : null;
    if (ownerIsSigning && !ownerReview?.files[0])
      fail(409, "Review this document version before creating invitations.");
    await verifiedEvidenceFile(document.fileKey, document.sourceHash);
    const preview = ownerReview?.files[0]
      ? await verifiedEvidenceFile(
          ownerReview.files[0].fileKey,
          ownerReview.files[0].sha256,
        )
      : await renderPdf(document.fileKey, ownerLayers, false);
    const previewKey = await storeFile(preview, "pdf");
    try {
      const created = await db.transaction(async (tx) => {
        await tx.execute(
          sql`select id from document where id = ${id} and user_id = ${u.id} for update`,
        );
        await tx.execute(
          sql`select id from "user" where id = ${u.id} for update`,
        );
        await assertStorageBudget(u.id, preview.length, tx);
        if (ownerIsSigning)
          await recordOwnerAcceptance(
            tx,
            document,
            u,
            body.ownerReviewId!,
            ownerLayers,
          );
        const [updated] = await tx
          .update(documents)
          .set({
            status: "awaiting",
            previewKey,
            revision: document.revision + 1,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(documents.id, id),
              eq(documents.userId, u.id),
              eq(documents.revision, body.revision),
              eq(documents.status, "draft"),
            ),
          )
          .returning();
        if (!updated)
          fail(
            409,
            "This document changed. Reload before creating signing links.",
          );
        const rows = body.recipients.map((r, index) => {
          const token = randomBytes(32).toString("base64url");
          return {
            id: randomUUID(),
            documentId: id,
            name: r.name,
            email: r.email.toLowerCase(),
            signingOrder: index + 1,
            field: { ...r.field, textFields: r.textFields },
            tokenHash: sha256(token),
            sealedToken: seal(token),
            expiresAt: new Date(Date.now() + 7 * 86400000),
          };
        });
        const result = await tx.insert(invitations).values(rows).returning();
        await tx.insert(audit).values({
          id: randomUUID(),
          documentId: id,
          actor: u.id,
          event: "invitations_created",
          details: {
            sourceHash: document.sourceHash,
            previewHash: sha256(preview),
            recipients: rows.map((r) => r.email),
            signingOrder: rows.map((r) => ({
              id: r.id,
              signingOrder: r.signingOrder,
            })),
            signingMode: "serial",
            termsLocked: true,
          },
        });
        return result;
      });
      return reply
        .status(201)
        .send(created.map((r) => publicInvitation(r, created)));
    } catch (error) {
      await removeFile(previewKey);
      throw error;
    }
  });
  app.post(
    "/api/documents/:id/invitations/:invitationId/revoke",
    async (req) => {
      const u = await actor(req),
        id = getId(req),
        invitationId = getId(req, "invitationId");
      let due: InvitationRow[] = [];
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`select id from document where id = ${id} and user_id = ${u.id} for update`,
        );
        const currentDocument = await ownerDoc(id, u.id, tx);
        const before = await documentInvitations(id, tx);
        const [revoked] = await tx
          .update(invitations)
          .set({ state: "revoked" })
          .where(
            and(
              eq(invitations.id, invitationId),
              eq(invitations.documentId, id),
              eq(invitations.state, "pending"),
            ),
          )
          .returning();
        if (!revoked) fail(409, "Only a pending signing link can be revoked.");
        const remaining = await tx
          .select()
          .from(invitations)
          .where(eq(invitations.documentId, id));
        due = newTurns(before, remaining);
        await tx
          .update(documents)
          .set({
            status: remaining.some((r) => r.state === "pending")
              ? "awaiting"
              : "completed",
            updatedAt: new Date(),
            revision: sql`${documents.revision} + 1`,
          })
          .where(eq(documents.id, id));
        await tx.insert(audit).values({
          id: randomUUID(),
          documentId: id,
          actor: u.id,
          event: "invitation_revoked",
          details: { invitationId, signingOrder: revoked.signingOrder },
        });
        if (!remaining.some((r) => r.state === "pending")) {
          const acceptance = await tx.query.evidenceRecords.findFirst({
            where: and(
              eq(evidenceRecords.documentId, id),
              eq(evidenceRecords.kind, "acceptance"),
            ),
          });
          if (acceptance)
            await ensureCanonicalExport(tx, {
              documentId: id,
              revision: currentDocument.revision + 1,
              originalKey: currentDocument.previewKey!,
              layers: remaining
                .filter((r) => r.state === "signed")
                .flatMap(signedLayers),
            });
        }
      });
      emailNewTurnsLater(id, due, u.id, req.log);
      return { ok: true };
    },
  );
  app.get("/api/documents/:id/invitations/:invitationId/email", async (req) => {
    const u = await actor(req),
      doc = await ownerDoc(getId(req), u.id);
    const invitation = await db.query.invitations.findFirst({
      where: and(
        eq(invitations.id, getId(req, "invitationId")),
        eq(invitations.documentId, doc.id),
      ),
    });
    if (!invitation) fail(404, "Invitation not found.");
    const preview = mailPreview(
      invitation!,
      doc,
      u.name,
      await documentInvitations(doc.id),
    );
    return {
      ...preview,
      previewHash: sha256(JSON.stringify(preview)),
      enabled: emailEnabled,
    };
  });
  app.post(
    "/api/documents/:id/invitations/:invitationId/email",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (req) => {
      const u = await actor(req),
        doc = await ownerDoc(getId(req), u.id);
      if (!emailEnabled)
        fail(
          503,
          "Email delivery is not configured. Copy the signing link instead.",
        );
      const body = z.object({ previewHash: z.string() }).parse(req.body);
      const invitation = await db.query.invitations.findFirst({
        where: and(
          eq(invitations.id, getId(req, "invitationId")),
          eq(invitations.documentId, doc.id),
          eq(invitations.state, "pending"),
        ),
      });
      if (!invitation || invitation.expiresAt < new Date())
        fail(409, "This signing link is no longer active.");
      const preview = mailPreview(
        invitation!,
        doc,
        u.name,
        await documentInvitations(doc.id),
      );
      if (sha256(JSON.stringify(preview)) !== body.previewHash)
        fail(409, "The invitation changed. Review the email again.");
      await sendSecurityMail({
        to: preview.to,
        subject: preview.subject,
        text: preview.body,
        html: preview.html,
      });
      await db.insert(audit).values({
        id: randomUUID(),
        documentId: doc.id,
        actor: u.id,
        event: "invitation_email_accepted",
        details: { invitationId: invitation!.id },
      });
      return { ok: true };
    },
  );

  app.get("/api/sign/:token", async (req) => {
    const snapshot = await signingSnapshot(req, true);
    const { invitation: r, document: d } = snapshot;
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });
    return {
      name: r.name,
      documentName: d.name,
      pages: d.pages,
      field: signatureField(r.field),
      textFields: r.field.textFields ?? [],
      state: r.state,
      signedAt: r.signedAt,
      expiresAt: r.expiresAt,
      completed: d.status === "completed",
      cancelled: d.status === "cancelled",
      revision: d.revision,
      totalSigners: snapshot.recipients.length,
      verification: await verificationStatus(req, signerContext(r, d)),
      recordVerification:
        r.state === "signed"
          ? await verificationStatus(req, {
              ...signerContext(r, d),
              purpose: "record",
            })
          : undefined,
      consent: SIGNING_CONSENT,
      canUseSavedSignature:
        session?.user.email.toLowerCase() === r.email.toLowerCase(),
      ...signingProgress(r, snapshot.recipients),
    };
  });
  function signerContext(
    invitation: InvitationRow,
    document: typeof documents.$inferSelect,
  ): VerificationContext {
    return {
      invitationId: invitation.id,
      documentId: document.id,
      email: invitation.email,
      revision: document.revision,
      purpose: "sign",
    };
  }
  app.post(
    "/api/sign/:token/verification/send",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { revision } = z
        .object({ revision: z.number().int().positive() })
        .parse(req.body);
      const snapshot = await signingSnapshot(req);
      if (!snapshot.canSign)
        fail(409, "This request is not ready for signing.");
      if (revision !== snapshot.document.revision)
        fail(
          409,
          "This document changed. Reload it before verifying your email.",
        );
      return sendVerificationCode(
        req,
        reply,
        signerContext(snapshot.invitation, snapshot.document),
      );
    },
  );
  app.post(
    "/api/sign/:token/verification/confirm",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req) => {
      const { revision, code } = z
        .object({
          revision: z.number().int().positive(),
          code: z.string().regex(/^\d{6}$/),
        })
        .parse(req.body);
      const snapshot = await signingSnapshot(req);
      if (!snapshot.canSign)
        fail(409, "This request is not ready for signing.");
      if (revision !== snapshot.document.revision)
        fail(
          409,
          "This document changed. Reload it before verifying your email.",
        );
      return confirmVerificationCode(
        req,
        signerContext(snapshot.invitation, snapshot.document),
        code,
      );
    },
  );
  app.get(
    "/api/sign/:token/pdf",
    { config: { rateLimit: { max: 15, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { revision } = z
        .object({ revision: z.coerce.number().int().positive() })
        .parse(req.query);
      const initial = await recipient(req);
      const review = await db.transaction(async (tx) => {
        await tx.execute(
          sql`select id from document where id = ${initial.document.id} for update`,
        );
        const { invitation, document } = await recipient(req, tx);
        const recipients = await documentInvitations(document.id, tx);
        if (document.revision !== revision)
          fail(
            409,
            "This document changed. Reload it to review the latest signatures.",
          );
        if (!signingProgress(invitation, recipients).canSign)
          fail(409, "This request is not ready for signing.");
        await requireVerifiedMailbox(
          req,
          signerContext(invitation, document),
          tx,
        );
        const layers = recipients
          .filter((r) => r.state === "signed")
          .flatMap(signedLayers);
        return retainReview(tx, {
          documentId: document.id,
          actor: invitation.id,
          revision,
          bytes: layers.length
            ? await renderPdf(document.previewKey!, layers, false)
            : await loadFile(document.previewKey!),
        });
      });
      return reply
        .type("application/pdf")
        .header("X-PaperSign-Review", review.id)
        .header("X-PaperSign-Review-SHA256", review.sha256)
        .send(await verifiedEvidenceFile(review.fileKey, review.sha256));
    },
  );
  app.post(
    "/api/sign/:token",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req) => {
      const { invitation: r, document } = await recipient(req);
      if (document.status !== "awaiting" || document.deletedAt)
        fail(409, "This document is no longer available for signing.");
      const body = z
        .object({
          name: z.string().trim().min(1).max(100),
          consent: z.literal(true),
          consentVersion: z.literal(SIGNING_CONSENT.version),
          reviewId: idSchema,
          revision: z.number().int().positive(),
          png: pngSchema.optional(),
          signatureId: idSchema.optional(),
          textValues: z
            .array(z.object({ id: idSchema, text: textValueSchema }))
            .max(10)
            .default([]),
        })
        .refine(
          (v) => Boolean(v.png) !== Boolean(v.signatureId),
          "Draw, upload, or choose one signature.",
        )
        .parse(req.body);
      if (r.state !== "pending")
        fail(409, "This request has already been signed.");
      if (document.revision !== body.revision)
        fail(
          409,
          "This document changed. Reload it to review the latest signatures before signing.",
        );
      if (!signingProgress(r, await documentInvitations(document.id)).canSign)
        fail(409, "Your turn opens once the earlier signers have finished.");
      await requireVerifiedMailbox(req, signerContext(r, document));
      validateTextValues(r.field, body.textValues, document.pages);
      let normalized: { bytes: Buffer; width: number; height: number };
      if (body.signatureId) {
        const u = await actor(req),
          sig = await db.query.signatures.findFirst({
            where: and(
              eq(signatures.id, body.signatureId),
              eq(signatures.userId, u.id),
              isNull(signatures.deletedAt),
            ),
          });
        if (u.email.toLowerCase() !== r.email.toLowerCase())
          fail(
            403,
            "Sign in with the invited email address to use a saved signature.",
          );
        if (!sig) fail(404, "Signature not found.");
        normalized = {
          bytes: await loadFile(sig!.fileKey),
          width: sig!.width,
          height: sig!.height,
        };
      } else
        normalized = await normalizeSignature(body.png!).catch((e) =>
          fail(
            400,
            e.statusCode === 400
              ? e.message
              : "This PNG could not be read. Choose another signature image.",
          ),
        );
      const imageKey = await storeFile(normalized.bytes, "png");
      let acceptanceReceipt: { id: string; hash: string } | undefined;
      let due: InvitationRow[] = [];
      try {
        await db.transaction(async (tx) => {
          await tx.execute(
            sql`select id from document where id = ${document.id} for update`,
          );
          const { invitation: current, document: currentDocument } =
            await recipient(req, tx);
          if (
            currentDocument.status !== "awaiting" ||
            currentDocument.deletedAt
          )
            fail(409, "This document is no longer available for signing.");
          if (current.state !== "pending")
            fail(409, "This request has already been signed.");
          if (currentDocument.revision !== body.revision)
            fail(
              409,
              "This document changed. Reload it to review the latest signatures before signing.",
            );
          const before = await documentInvitations(document.id, tx);
          if (!signingProgress(current, before).canSign)
            fail(
              409,
              "Your turn opens once the earlier signers have finished.",
            );
          const authentication = await requireVerifiedMailbox(
            req,
            signerContext(current, currentDocument),
            tx,
          );
          await tx.execute(
            sql`select id from "user" where id = ${currentDocument.userId} for update`,
          );
          await assertStorageBudget(
            currentDocument.userId,
            normalized.bytes.length,
            tx,
          );
          const textValues = validateTextValues(
            current.field,
            body.textValues,
            currentDocument.pages,
          );
          const page = currentDocument.pages[current.field.pageIndex],
            field = { ...current.field, textValues };
          const targetRatio =
              (field.width * page.width) / (field.height * page.height),
            imageRatio = normalized.width / normalized.height;
          if (imageRatio > targetRatio) {
            const height =
              (field.width * page.width) / imageRatio / page.height;
            field.y += (field.height - height) / 2;
            field.height = height;
          } else {
            const width =
              (field.height * page.height * imageRatio) / page.width;
            field.x += (field.width - width) / 2;
            field.width = width;
          }
          acceptanceReceipt = await recordAcceptance(tx, {
            documentId: document.id,
            actor: current.id,
            revision: currentDocument.revision,
            reviewId: body.reviewId,
            authentication,
            statedName: body.name,
            consent: SIGNING_CONSENT,
            signature: { fileKey: imageKey, bytes: normalized.bytes },
            fields: { field, textValues },
          });
          await consumeSignerVerification(tx, authentication.verificationId);
          const [signed] = await tx
            .update(invitations)
            .set({
              state: "signed",
              signedAt: new Date(),
              signedName: body.name,
              imageKey,
              field,
            })
            .where(
              and(
                eq(invitations.id, r.id),
                eq(invitations.state, "pending"),
                sql`${invitations.expiresAt} > now()`,
              ),
            )
            .returning();
          if (!signed) fail(409, "This signing link is no longer available.");
          const remaining = await tx
            .select()
            .from(invitations)
            .where(
              and(
                eq(invitations.documentId, document.id),
                eq(invitations.state, "pending"),
              ),
            );
          due = newTurns(before, remaining);
          await tx
            .update(documents)
            .set({
              status: remaining.length ? "awaiting" : "completed",
              revision: sql`${documents.revision} + 1`,
              updatedAt: new Date(),
            })
            .where(eq(documents.id, document.id));
          await tx.insert(audit).values({
            id: randomUUID(),
            documentId: document.id,
            actor: r.id,
            event: "signature_accepted",
            details: {
              statedName: body.name,
              intendedEmail: r.email,
              consent: true,
              reviewedRevision: currentDocument.revision,
              signingOrder: current.signingOrder,
              signingMode: "serial",
              sourceHash: document.sourceHash,
              signatureHash: sha256(normalized.bytes),
              textHash: sha256(
                JSON.stringify(textLayers(current.field, textValues)),
              ),
              authentication,
              consentVersion: SIGNING_CONSENT.version,
              consentText: SIGNING_CONSENT.text,
              reviewId: body.reviewId,
              acceptanceReceiptHash: acceptanceReceipt.hash,
            },
          });
          if (!remaining.length)
            await ensureCanonicalExport(tx, {
              documentId: document.id,
              revision: currentDocument.revision + 1,
              originalKey: currentDocument.previewKey!,
              layers: (await documentInvitations(document.id, tx))
                .filter((invitation) => invitation.state === "signed")
                .flatMap(signedLayers),
            });
        });
      } catch (error) {
        await removeFile(imageKey);
        throw error;
      }
      emailNewTurnsLater(document.id, due, r.id, req.log);
      return {
        state: "signed",
        acceptanceReceiptId: acceptanceReceipt!.id,
        acceptanceReceiptHash: acceptanceReceipt!.hash,
      };
    },
  );
  registerRecipientRecordRoutes(app);
  app.get("/api/documents/:id/history", async (req) => {
    const u = await actor(req),
      document = await ownerDoc(getId(req), u.id);
    return db
      .select({
        event: audit.event,
        details: audit.details,
        createdAt: audit.createdAt,
      })
      .from(audit)
      .where(eq(audit.documentId, document.id))
      .orderBy(audit.createdAt);
  });
  if (existsSync(resolve("dist/index.html"))) {
    await app.register(fastifyStatic, {
      root: resolve("dist"),
      wildcard: false,
    });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith("/api/")
        ? reply.status(404).send({ message: "Not found." })
        : reply.header("Cache-Control", "no-cache").sendFile("index.html"),
    );
  }
  return app;
}
