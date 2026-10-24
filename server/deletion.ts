import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "./db.js";
import { config } from "./config.js";
import {
  user,
  documents,
  invitations,
  exportsTable,
  audit,
  adminEvents,
  evidenceRecords,
  evidenceTimestamps,
  signerVerifications,
} from "./schema.js";
import { loadFile, removeFile, sha256 } from "./storage.js";
import { canonicalJson } from "./evidence-core.js";
type Reader = Pick<typeof db, "query" | "select" | "execute">;
export interface DeletionPlan {
  documentId: string;
  actorId: string;
  name: string;
  sourceHash: string;
  revision: number;
  requestedAt: string;
  approvedAt: string;
  eligibleAt: string;
  files: Array<{ key: string; sha256: string; size: number }>;
  evidenceHashes: string[];
  fingerprint: string;
}
export async function planDocumentDeletion(
  documentId: string,
  actorId: string,
  reader: Reader = db,
): Promise<DeletionPlan> {
  const actor = await reader.query.user.findFirst({
    where: eq(user.id, actorId),
  });
  if (actor?.role !== "admin")
    throw new Error("The recorded operator must be an existing Admin.");
  const document = await reader.query.documents.findFirst({
    where: eq(documents.id, documentId),
  });
  if (!document?.deletionRequestedAt || !document.deletedAt)
    throw new Error("Document deletion must be requested and approved first.");
  const requests = await reader
    .select()
    .from(invitations)
    .where(eq(invitations.documentId, documentId));
  const exports = await reader
    .select()
    .from(exportsTable)
    .where(eq(exportsTable.documentId, documentId));
  if (
    document.status === "awaiting" ||
    requests.some((r) => r.state === "pending") ||
    exports.some((r) => ["queued", "working"].includes(r.state))
  )
    throw new Error(
      "Signing and export jobs must finish or be cancelled before deletion.",
    );
  const evidence = await reader
    .select()
    .from(evidenceRecords)
    .where(eq(evidenceRecords.documentId, documentId))
    .orderBy(evidenceRecords.sequence);
  const timestamps = await reader
    .select()
    .from(evidenceTimestamps)
    .where(eq(evidenceTimestamps.documentId, documentId));
  const keys = [
    ...new Set(
      [
        document.fileKey,
        document.previewKey,
        ...requests.map((r) => r.imageKey),
        ...exports.flatMap((r) => [
          r.fileKey,
          ...r.sourceFiles.map((f) => f.fileKey),
        ]),
        ...evidence.flatMap((r) => r.files.map((f) => f.fileKey)),
        ...timestamps.map((r) => r.fileKey),
      ].filter((key): key is string => !!key),
    ),
  ].sort();
  const files = [];
  for (const key of keys) {
    const bytes = await loadFile(key);
    files.push({ key, sha256: sha256(bytes), size: bytes.length });
  }
  const content = {
    documentId,
    actorId,
    name: document.name,
    sourceHash: document.sourceHash,
    revision: document.revision,
    requestedAt: document.deletionRequestedAt.toISOString(),
    approvedAt: document.deletedAt.toISOString(),
    eligibleAt: new Date(
      document.deletedAt.getTime() + config.DELETION_GRACE_DAYS * 86400_000,
    ).toISOString(),
    files,
    evidenceHashes: evidence.map((r) => r.hash),
  };
  return { ...content, fingerprint: sha256(canonicalJson(content)) };
}
export async function applyDocumentDeletion(
  documentId: string,
  actorId: string,
  expectedFingerprint: string,
  reason: string,
) {
  if (!reason.trim())
    throw new Error("A recorded deletion reason is required.");
  const plan = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select id from document where id=${documentId} for update`,
    );
    const current = await planDocumentDeletion(documentId, actorId, tx);
    if (current.fingerprint !== expectedFingerprint)
      throw new Error("The deletion plan changed. Review a fresh plan.");
    if (Date.now() < new Date(current.eligibleAt).getTime())
      throw new Error("The recovery window has not ended.");
    await tx
      .delete(signerVerifications)
      .where(eq(signerVerifications.documentId, documentId));
    await tx
      .delete(evidenceTimestamps)
      .where(eq(evidenceTimestamps.documentId, documentId));
    await tx
      .delete(evidenceRecords)
      .where(eq(evidenceRecords.documentId, documentId));
    await tx.delete(audit).where(eq(audit.documentId, documentId));
    await tx
      .delete(exportsTable)
      .where(eq(exportsTable.documentId, documentId));
    await tx.delete(invitations).where(eq(invitations.documentId, documentId));
    await tx.delete(documents).where(eq(documents.id, documentId));
    await tx
      .insert(adminEvents)
      .values({
        id: randomUUID(),
        actorId,
        event: "document_permanently_deleted",
        targetType: "document",
        targetId: documentId,
        details: {
          reason: reason.trim().slice(0, 500),
          sourceHash: current.sourceHash,
          planFingerprint: current.fingerprint,
          evidenceHashes: current.evidenceHashes,
          files: current.files,
        },
      });
    return current;
  });
  return resumeDocumentCleanup(documentId, actorId, plan.fingerprint);
}
export async function resumeDocumentCleanup(
  documentId: string,
  actorId: string,
  expectedFingerprint: string,
) {
  const actor = await db.query.user.findFirst({ where: eq(user.id, actorId) });
  if (actor?.role !== "admin")
    throw new Error("The recorded operator must be an existing Admin.");
  if (
    await db.query.documents.findFirst({ where: eq(documents.id, documentId) })
  )
    throw new Error(
      "The document still exists; permanent deletion has not completed.",
    );
  const tombstone = await db.query.adminEvents.findFirst({
    where: and(
      eq(adminEvents.targetId, documentId),
      eq(adminEvents.event, "document_permanently_deleted"),
    ),
  });
  if (!tombstone)
    throw new Error("No permanent deletion record exists for this document.");
  const plan = z
    .object({
      planFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      files: z.array(
        z.object({
          key: z.string(),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
          size: z.number().nonnegative(),
        }),
      ),
    })
    .parse(tombstone.details);
  if (plan.planFingerprint !== expectedFingerprint)
    throw new Error(
      "The deletion fingerprint does not match the permanent deletion record.",
    );
  const removed: string[] = [],
    retained: string[] = [],
    failed: string[] = [];
  for (const file of plan.files) {
    try {
      const reference =
        await db.execute(sql`select 1 from document where file_key=${file.key} or preview_key=${file.key}
   union all select 1 from signature where file_key=${file.key}
   union all select 1 from invitation where image_key=${file.key}
   union all select 1 from document_export where file_key=${file.key} or original_key=${file.key} or source_files @> ${JSON.stringify([{ fileKey: file.key }])}::jsonb
   union all select 1 from evidence_record where files @> ${JSON.stringify([{ fileKey: file.key }])}::jsonb
   union all select 1 from document_evidence_timestamp where file_key=${file.key} limit 1`);
      if (reference.rows.length) {
        retained.push(file.key);
        continue;
      }
      let bytes: Buffer;
      try {
        bytes = await loadFile(file.key);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          removed.push(file.key);
          continue;
        }
        throw error;
      }
      if (sha256(bytes) !== file.sha256 || bytes.length !== file.size)
        throw new Error("Stored file changed after deletion was approved.");
      await removeFile(file.key);
      removed.push(file.key);
    } catch {
      failed.push(file.key);
    }
  }
  await db
    .insert(adminEvents)
    .values({
      id: randomUUID(),
      actorId,
      event: failed.length
        ? "deletion_file_cleanup_required"
        : "deletion_file_cleanup_completed",
      targetType: "document",
      targetId: documentId,
      details: {
        planFingerprint: expectedFingerprint,
        removed: removed.length,
        shared: retained.length,
        files: failed,
      },
    });
  return {
    documentId,
    removedFiles: removed.length,
    sharedFilesRetained: retained.length,
    cleanupRequired: failed,
  };
}
