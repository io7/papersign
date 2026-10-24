import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "./db.js";
import {
  documents,
  invitations,
  exportsTable,
  audit,
  evidenceRecords,
  user,
  signatures,
  adminEvents,
} from "./schema.js";
import { config } from "./config.js";
import { requireAccountVerification } from "./account-security.js";
import { renderPdf } from "./pdf.js";
import { loadFile, seal, sha256 } from "./storage.js";
import { accountStorageBytes } from "./storage-usage.js";
import {
  retainReview,
  recordAcceptance,
  ensureCanonicalExport,
  completedEvidence,
  getCompletedRecord,
  verifiedEvidenceFile,
} from "./evidence.js";
import { buildEvidenceArchive } from "./evidence-archive.js";
import { SIGNING_CONSENT } from "../shared/signing-consent.js";
import type { FrozenPlacement } from "../shared/types.js";

type Document = typeof documents.$inferSelect;
type Reader = Pick<typeof db, "select" | "query">;
type Dependencies = {
  actor(req: FastifyRequest): Promise<{
    id: string;
    name: string;
    email: string;
    emailVerified: boolean;
  }>;
  allLayers(document: Document, reader?: Reader): Promise<FrozenPlacement[]>;
  publicDocument(document: Document): unknown;
};
const revisionBody = z.object({ revision: z.number().int().positive() });
const getId = (req: FastifyRequest) =>
  z
    .string()
    .uuid()
    .parse((req.params as { id: string }).id);
function fail(statusCode: number, message: string): never {
  throw Object.assign(new Error(message), { statusCode, publicError: true });
}
async function owned(id: string, owner: string, reader: Reader = db) {
  const document = await reader.query.documents.findFirst({
    where: and(eq(documents.id, id), eq(documents.userId, owner)),
  });
  return document ?? fail(404, "Document not found.");
}
async function locked(
  id: string,
  owner: string,
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  revision: number,
) {
  await tx.execute(
    sql`select id from document where id = ${id} and user_id = ${owner} for update`,
  );
  const document = await owned(id, owner, tx);
  if (document.revision !== revision)
    fail(409, "This document changed. Reload it before continuing.");
  return document;
}

export async function recordOwnerAcceptance(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  document: Document,
  actor: { id: string; name: string; email: string },
  reviewId: string,
  layers: FrozenPlacement[],
) {
  const review = await tx.query.evidenceRecords.findFirst({
    where: and(
      eq(evidenceRecords.id, reviewId),
      eq(evidenceRecords.actor, `owner:${actor.id}`),
      eq(evidenceRecords.documentId, document.id),
      eq(evidenceRecords.revision, document.revision),
      eq(evidenceRecords.kind, "review"),
    ),
  });
  if (!review?.files[0]) fail(409, "Review this version before signing.");
  const images = await Promise.all(
    [
      ...new Set(
        layers
          .filter((layer) => layer.kind !== "text")
          .map((layer) => layer.imageKey),
      ),
    ].map(async (fileKey) => ({ fileKey, bytes: await loadFile(fileKey) })),
  );
  if (!images[0]) fail(400, "Add a signature before signing.");
  const portableLayers = layers.map((layer) => {
    if (layer.kind === "text") return layer;
    const { imageKey, ...geometry } = layer;
    return {
      ...geometry,
      signatureSha256: sha256(
        images.find((image) => image.fileKey === imageKey)!.bytes,
      ),
    };
  });
  await recordAcceptance(tx, {
    documentId: document.id,
    actor: `owner:${actor.id}`,
    revision: document.revision,
    reviewId,
    authentication: {
      method: "verified-account",
      email: actor.email,
      checkedAt: new Date().toISOString(),
      accountId: actor.id,
    },
    statedName: actor.name,
    consent: SIGNING_CONSENT,
    signature: images[0],
    additionalSignatures: images.slice(1),
    fields: { layers: portableLayers },
  });
  return review;
}
export async function registerDocumentLifecycleRoutes(
  app: FastifyInstance,
  deps: Dependencies,
) {
  app.get("/api/privacy", async () => ({
    operator: config.OPERATOR_NAME ?? null,
    adminAccess:
      "Administrators can view uploaded original PDFs. Each administrative PDF access is recorded.",
    evidence:
      "Signing records include the document, completed fields, consent wording, verified email, acceptance times and document hashes. Email verification proves mailbox control; it does not verify a person's legal identity or authority to represent a company.",
    retention:
      config.DELETION_APPROVAL_REQUIRED === "true"
        ? "Completed signing records have no automatic expiry. An administrator reviews document deletion requests before the recovery window starts."
        : "Completed signing records stay until the owner requests deletion. That request starts the recovery window; permanent removal requires a separate operator action that considers other participants' retained evidence.",
    recoveryDays: config.DELETION_GRACE_DAYS,
    deletionApprovalRequired: config.DELETION_APPROVAL_REQUIRED === "true",
    backups:
      "Recovery backups may retain deleted content until their configured expiry. Permanent deletion and backup expiry require an operator's recorded action.",
  }));
  app.get("/api/account/storage", async (req) => {
    const u = await deps.actor(req);
    const account = await db.query.user.findFirst({ where: eq(user.id, u.id) });
    return {
      usedBytes: await accountStorageBytes(u.id),
      limitBytes: config.ACCOUNT_STORAGE_LIMIT_BYTES,
      deletionRequestedAt: account?.deletionRequestedAt,
    };
  });
  app.get("/api/account/data-index", async (req, reply) => {
    const u = await deps.actor(req);
    const rows = await db
      .select()
      .from(documents)
      .where(eq(documents.userId, u.id));
    const library = await db
      .select({
        id: signatures.id,
        name: signatures.name,
        createdAt: signatures.createdAt,
        deletedAt: signatures.deletedAt,
      })
      .from(signatures)
      .where(eq(signatures.userId, u.id));
    return reply
      .header(
        "Content-Disposition",
        "attachment; filename=papersign-account-index.json",
      )
      .send({
        format: "papersign-account-index-v1",
        createdAt: new Date().toISOString(),
        account: { id: u.id, name: u.name, email: u.email },
        documents: rows.map((row) => ({
          id: row.id,
          name: row.name,
          status: row.status,
          createdAt: row.createdAt,
          sourceHash: row.sourceHash,
          deletionRequestedAt: row.deletionRequestedAt,
          originalUrl: `${config.APP_URL}/api/documents/${row.id}/pdf`,
          recordUrl: `${config.APP_URL}/api/documents/${row.id}/record/evidence`,
        })),
        signatures: library,
        note: "This index lists your account data. Download original PDFs and completed signing records separately using the authenticated links.",
      });
  });
  app.post("/api/account/deletion-request", async (req) => {
    const u = await deps.actor(req),
      body = z.object({ confirmEmail: z.string().email() }).parse(req.body);
    if (body.confirmEmail.toLowerCase() !== u.email.toLowerCase())
      fail(400, "Enter your account email to confirm the request.");
    await db.transaction(async (tx) => {
      await tx
        .update(user)
        .set({ deletionRequestedAt: new Date() })
        .where(eq(user.id, u.id));
      await tx.insert(adminEvents).values({
        id: randomUUID(),
        actorId: u.id,
        event: "account_deletion_requested",
        targetType: "user",
        targetId: u.id,
        details: {},
      });
    });
    return { state: "awaiting-approval" };
  });
  app.post("/api/account/deletion-request/withdraw", async (req) => {
    const u = await deps.actor(req);
    await db
      .update(user)
      .set({ deletionRequestedAt: null })
      .where(eq(user.id, u.id));
    return { ok: true };
  });
  app.post("/api/documents/:id/review", async (req) => {
    const u = await deps.actor(req),
      id = getId(req),
      body = revisionBody.parse(req.body);
    requireAccountVerification(u);
    return db.transaction(async (tx) => {
      const document = await locked(id, u.id, tx, body.revision);
      if (document.status !== "draft" || document.deletedAt)
        fail(409, "Only a draft can be finalized with your own signature.");
      const layers = await deps.allLayers(document, tx);
      if (!layers.some((layer) => layer.kind !== "text"))
        fail(400, "Add your signature before reviewing the completed PDF.");
      await verifiedEvidenceFile(document.fileKey, document.sourceHash);
      const bytes = await renderPdf(document.fileKey, layers, false);
      const review = await retainReview(tx, {
        documentId: id,
        actor: `owner:${u.id}`,
        revision: document.revision,
        bytes,
      });
      return {
        reviewId: review.id,
        sha256: review.sha256,
        revision: document.revision,
        consent: SIGNING_CONSENT,
        pdfUrl: `/api/documents/${id}/reviews/${review.id}/pdf`,
      };
    });
  });
  app.get("/api/documents/:id/reviews/:reviewId/pdf", async (req, reply) => {
    const u = await deps.actor(req),
      id = getId(req);
    await owned(id, u.id);
    const reviewId = z
      .string()
      .uuid()
      .parse((req.params as { reviewId: string }).reviewId);
    const record = await db.query.evidenceRecords.findFirst({
      where: and(
        eq(evidenceRecords.id, reviewId),
        eq(evidenceRecords.documentId, id),
        eq(evidenceRecords.actor, `owner:${u.id}`),
        eq(evidenceRecords.kind, "review"),
      ),
    });
    if (!record?.files[0]) fail(404, "Review not found.");
    reply
      .header("X-PaperSign-Review-Id", record.id)
      .header("X-PaperSign-Review-SHA256", record.files[0].sha256);
    return reply
      .type("application/pdf")
      .send(
        await verifiedEvidenceFile(
          record.files[0].fileKey,
          record.files[0].sha256,
        ),
      );
  });
  app.post("/api/documents/:id/finalize", async (req, reply) => {
    const u = await deps.actor(req),
      id = getId(req),
      body = revisionBody
        .extend({
          reviewId: z.string().uuid(),
          consent: z.literal(true),
          consentVersion: z.literal(SIGNING_CONSENT.version),
        })
        .parse(req.body);
    requireAccountVerification(u);
    const result = await db.transaction(async (tx) => {
      const document = await locked(id, u.id, tx, body.revision);
      if (document.status !== "draft" || document.deletedAt)
        fail(
          409,
          "This document has already been finalized or sent for signing.",
        );
      const layers = await deps.allLayers(document, tx);
      const image = layers.find((layer) => layer.kind !== "text");
      if (!image) fail(400, "Add a signature before finalizing this document.");
      const review = await recordOwnerAcceptance(
        tx,
        document,
        u,
        body.reviewId,
        layers,
      );
      const [updated] = await tx
        .update(documents)
        .set({
          status: "completed",
          previewKey: review.files[0].fileKey,
          revision: document.revision + 1,
          updatedAt: new Date(),
        })
        .where(eq(documents.id, id))
        .returning();
      const record = await ensureCanonicalExport(tx, {
        documentId: id,
        revision: updated.revision,
        originalKey: review.files[0].fileKey,
        layers: [],
      });
      await tx.insert(audit).values({
        id: randomUUID(),
        documentId: id,
        actor: u.id,
        event: "owner_signature_accepted",
        details: {
          reviewId: review.id,
          reviewedPdfSha256: review.files[0].sha256,
          consent: SIGNING_CONSENT,
          authentication: "verified-account",
          email: u.email,
        },
      });
      return { document: deps.publicDocument(updated), exportId: record.id };
    });
    return reply.status(202).send(result);
  });
  app.get("/api/documents/:id/record", async (req) => {
    const u = await deps.actor(req),
      document = await owned(getId(req), u.id);
    const record = await db.query.exportsTable.findFirst({
      where: and(
        eq(exportsTable.documentId, document.id),
        eq(exportsTable.canonical, true),
      ),
    });
    if (!record)
      return {
        state: "unavailable",
        message:
          "No preserved completion record exists for this document. Earlier downloads remain available.",
      };
    if (record.state !== "ready")
      return { state: record.state, error: record.error };
    if (!record.evidenceComplete)
      return {
        state: "ready",
        evidenceComplete: false,
        message:
          "This request includes signatures added before PaperSign preserved signing evidence. The final PDF is available, but a complete signing record cannot be created for those earlier signatures.",
      };
    const evidence = await completedEvidence(document.id);
    return {
      state: "ready",
      evidenceComplete: true,
      receipt: evidence.receipt,
      timestamp: evidence.timestamp,
    };
  });
  app.get("/api/documents/:id/record/pdf", async (req, reply) => {
    const u = await deps.actor(req),
      document = await owned(getId(req), u.id),
      record = await getCompletedRecord(document.id);
    return reply
      .header("Content-Disposition", "attachment; filename=completed.pdf")
      .type("application/pdf")
      .send(await verifiedEvidenceFile(record.fileKey!, record.sha256!));
  });
  app.get("/api/documents/:id/record/evidence", async (req, reply) => {
    const u = await deps.actor(req),
      document = await owned(getId(req), u.id),
      archive = await buildEvidenceArchive(document.id);
    return reply
      .header(
        "Content-Disposition",
        "attachment; filename=papersign-evidence.tar",
      )
      .type("application/x-tar")
      .send(archive.stream);
  });
  app.post("/api/documents/:id/record/retry", async (req, reply) => {
    const u = await deps.actor(req),
      id = getId(req);
    await owned(id, u.id);
    await db
      .update(exportsTable)
      .set({ state: "queued", error: null, startedAt: null })
      .where(
        and(
          eq(exportsTable.documentId, id),
          eq(exportsTable.canonical, true),
          eq(exportsTable.state, "failed"),
        ),
      );
    return reply.status(202).send({ ok: true });
  });
  app.post("/api/documents/:id/cancel", async (req) => {
    const u = await deps.actor(req),
      id = getId(req),
      body = revisionBody
        .extend({ reason: z.string().trim().min(1).max(500) })
        .parse(req.body);
    return db.transaction(async (tx) => {
      const document = await locked(id, u.id, tx, body.revision);
      if (document.status !== "awaiting")
        fail(409, "Only a signing request in progress can be cancelled.");
      await tx
        .update(invitations)
        .set({ state: "revoked" })
        .where(
          and(eq(invitations.documentId, id), eq(invitations.state, "pending")),
        );
      const [updated] = await tx
        .update(documents)
        .set({
          status: "cancelled",
          revision: document.revision + 1,
          updatedAt: new Date(),
        })
        .where(eq(documents.id, id))
        .returning();
      const acceptance = await tx.query.evidenceRecords.findFirst({
        where: and(
          eq(evidenceRecords.documentId, id),
          eq(evidenceRecords.kind, "acceptance"),
        ),
      });
      if (acceptance)
        await ensureCanonicalExport(tx, {
          documentId: id,
          revision: updated.revision,
          originalKey: document.fileKey,
          layers: await deps.allLayers(updated, tx),
        });
      await tx.insert(audit).values({
        id: randomUUID(),
        documentId: id,
        actor: u.id,
        event: "workflow_cancelled",
        details: { reason: body.reason, revision: updated.revision },
      });
      return deps.publicDocument(updated);
    });
  });
  app.post(
    "/api/documents/:id/invitations/:invitationId/reissue",
    async (req) => {
      const u = await deps.actor(req),
        id = getId(req),
        body = revisionBody.parse(req.body),
        invitationId = z
          .string()
          .uuid()
          .parse((req.params as { invitationId: string }).invitationId);
      requireAccountVerification(u);
      return db.transaction(async (tx) => {
        const document = await locked(id, u.id, tx, body.revision);
        if (document.status !== "awaiting" || document.deletedAt)
          fail(409, "This signing request is no longer active.");
        const invitation = await tx.query.invitations.findFirst({
          where: and(
            eq(invitations.id, invitationId),
            eq(invitations.documentId, id),
          ),
        });
        if (!invitation || invitation.state !== "pending")
          fail(409, "Only an unfinished invitation can be reissued.");
        const token = randomBytes(32).toString("base64url"),
          expiresAt = new Date(Date.now() + 7 * 86400_000);
        await tx
          .update(invitations)
          .set({
            tokenHash: sha256(token),
            sealedToken: seal(token),
            expiresAt,
          })
          .where(eq(invitations.id, invitationId));
        await tx
          .update(documents)
          .set({ revision: document.revision + 1, updatedAt: new Date() })
          .where(eq(documents.id, id));
        await tx.insert(audit).values({
          id: randomUUID(),
          documentId: id,
          actor: u.id,
          event: "invitation_reissued",
          details: {
            invitationId,
            previousExpiresAt: invitation.expiresAt.toISOString(),
            expiresAt: expiresAt.toISOString(),
            oldTokenHash: invitation.tokenHash,
          },
        });
        return { url: `${config.APP_URL}/sign/${token}`, expiresAt };
      });
    },
  );
  app.get("/api/documents/trash/list", async (req) => {
    const u = await deps.actor(req);
    const rows = await db
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.userId, u.id),
          isNotNull(documents.deletionRequestedAt),
        ),
      )
      .orderBy(desc(documents.deletionRequestedAt));
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      status: row.status,
      requestedAt: row.deletionRequestedAt,
      deletedAt: row.deletedAt,
    }));
  });
  app.post("/api/documents/:id/deletion-request", async (req) => {
    const u = await deps.actor(req),
      id = getId(req),
      body = revisionBody.extend({ confirmName: z.string() }).parse(req.body);
    return db.transaction(async (tx) => {
      const document = await locked(id, u.id, tx, body.revision);
      if (body.confirmName !== document.name)
        fail(400, "Enter the document's exact name to confirm the request.");
      if (document.status === "awaiting")
        fail(409, "Cancel the signing request before requesting deletion.");
      const deletedAt =
        config.DELETION_APPROVAL_REQUIRED === "false" ? new Date() : null;
      await tx
        .update(documents)
        .set({
          deletionRequestedAt: new Date(),
          deletedAt,
          updatedAt: new Date(),
        })
        .where(eq(documents.id, id));
      await tx.insert(audit).values({
        id: randomUUID(),
        documentId: id,
        actor: u.id,
        event: "deletion_requested",
        details: {
          approvalRequired: config.DELETION_APPROVAL_REQUIRED === "true",
          recoveryDays: config.DELETION_GRACE_DAYS,
        },
      });
      return { state: deletedAt ? "recoverable" : "awaiting-approval" };
    });
  });
  app.post("/api/documents/:id/restore", async (req) => {
    const u = await deps.actor(req),
      id = getId(req);
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`select id from document where id = ${id} and user_id = ${u.id} for update`,
      );
      const document = await owned(id, u.id, tx);
      if (!document.deletionRequestedAt) return;
      await tx
        .update(documents)
        .set({
          deletionRequestedAt: null,
          deletedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(documents.id, id));
      await tx.insert(audit).values({
        id: randomUUID(),
        documentId: id,
        actor: u.id,
        event: "deletion_withdrawn",
        details: {},
      });
    });
    return { ok: true };
  });
}
