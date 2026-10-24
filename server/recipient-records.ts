import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "./db.js";
import { documents, invitations, exportsTable } from "./schema.js";
import { sha256 } from "./storage.js";
import {
  completedEvidence,
  getCompletedRecord,
  verifiedEvidenceFile,
} from "./evidence.js";
import { buildEvidenceArchive } from "./evidence-archive.js";
import {
  sendVerificationCode,
  confirmVerificationCode,
  requireVerifiedMailbox,
  type VerificationContext,
} from "./signer-verification.js";

const fail = (statusCode: number, message: string): never => {
  throw Object.assign(new Error(message), { statusCode, publicError: true });
};

// A completed participant retains the invitation locator, but must obtain a fresh
// mailbox proof. This path never permits another signature or relaxes its deadline.
async function recordParticipant(req: FastifyRequest) {
  const token = z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/)
    .parse((req.params as { token: string }).token);
  const invitation = await db.query.invitations.findFirst({
    where: eq(invitations.tokenHash, sha256(token)),
  });
  if (!invitation || invitation.state !== "signed")
    fail(404, "This signing record is unavailable.");
  const document = await db.query.documents.findFirst({
    where: eq(documents.id, invitation!.documentId),
  });
  if (!document) fail(404, "This signing record is unavailable.");
  const context: VerificationContext = {
    invitationId: invitation!.id,
    documentId: document!.id,
    email: invitation!.email,
    revision: document!.revision,
    purpose: "record",
  };
  return { invitation: invitation!, document: document!, context };
}

export function registerRecipientRecordRoutes(app: FastifyInstance) {
  app.post(
    "/api/sign/:token/record/verification/send",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { revision } = z
        .object({ revision: z.number().int().positive() })
        .parse(req.body);
      const { context } = await recordParticipant(req);
      if (revision !== context.revision)
        fail(
          409,
          "The signing record changed. Reload it before verifying your email.",
        );
      return sendVerificationCode(req, reply, context);
    },
  );
  app.post(
    "/api/sign/:token/record/verification/confirm",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req) => {
      const { revision, code } = z
        .object({
          revision: z.number().int().positive(),
          code: z.string().regex(/^\d{6}$/),
        })
        .parse(req.body);
      const { context } = await recordParticipant(req);
      if (revision !== context.revision)
        fail(
          409,
          "The signing record changed. Reload it before verifying your email.",
        );
      return confirmVerificationCode(req, context, code);
    },
  );
  app.get("/api/sign/:token/record", async (req) => {
    const { document, context } = await recordParticipant(req);
    await requireVerifiedMailbox(req, context);
    if (!["completed", "cancelled"].includes(document.status))
      return { state: "waiting", documentName: document.name };
    const [record] = await db
      .select({
        state: exportsTable.state,
        evidenceComplete: exportsTable.evidenceComplete,
      })
      .from(exportsTable)
      .where(
        and(
          eq(exportsTable.documentId, document.id),
          eq(exportsTable.canonical, true),
        ),
      )
      .limit(1);
    if (!record) return { state: "unavailable", documentName: document.name };
    if (record.state !== "ready")
      return {
        state: record.state === "failed" ? "failed" : "preparing",
        documentName: document.name,
      };
    if (!record.evidenceComplete) {
      const participants = await db
        .select({
          name: invitations.name,
          order: invitations.signingOrder,
          state: invitations.state,
        })
        .from(invitations)
        .where(eq(invitations.documentId, document.id))
        .orderBy(asc(invitations.signingOrder));
      return {
        state: "ready",
        evidenceComplete: false,
        documentName: document.name,
        outcome:
          document.status === "cancelled"
            ? "cancelled"
            : participants.some((p) => p.state === "revoked")
              ? "completed-with-revocations"
              : "all-signed",
        participants,
      };
    }
    const { manifest, receipt, timestamp } = await completedEvidence(
      document.id,
    );
    return {
      state: "ready",
      evidenceComplete: true,
      documentName: document.name,
      outcome: manifest.outcome,
      participants: manifest.participants.map(({ name, order, state }) => ({
        name,
        order,
        state,
      })),
      receipt,
      timestamp,
    };
  });
  app.get("/api/sign/:token/record/pdf", async (req, reply) => {
    const { document, context } = await recordParticipant(req);
    await requireVerifiedMailbox(req, context);
    const record = await getCompletedRecord(document.id);
    return reply
      .type("application/pdf")
      .header("Content-Disposition", 'attachment; filename="signed.pdf"')
      .send(await verifiedEvidenceFile(record.fileKey!, record.sha256!));
  });
  app.get("/api/sign/:token/record/receipt", async (req, reply) => {
    const { document, context } = await recordParticipant(req);
    await requireVerifiedMailbox(req, context);
    const { receipt } = await completedEvidence(document.id);
    return reply
      .type("application/json")
      .header(
        "Content-Disposition",
        'attachment; filename="papersign-receipt.json"',
      )
      .send(JSON.stringify(receipt, null, 2) + "\n");
  });
  app.get(
    "/api/sign/:token/record/evidence",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { document, context } = await recordParticipant(req);
      await requireVerifiedMailbox(req, context);
      const archive = await buildEvidenceArchive(document.id);
      return reply
        .type("application/x-tar")
        .header(
          "Content-Disposition",
          'attachment; filename="papersign-evidence.tar"',
        )
        .send(archive.stream);
    },
  );
}
