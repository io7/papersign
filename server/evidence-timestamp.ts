import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { canonicalJson, evidenceHash } from "./evidence-core.js";
import { completedEvidence, verifiedEvidenceFile } from "./evidence.js";
import { evidenceTimestamps } from "./evidence-schema.js";
import { audit, documents } from "./schema.js";
import { db, pool } from "./db.js";
import { config } from "./config.js";
import { SealVerificationError } from "./sealing/types.js";
import { assertStorageBudget } from "./storage-usage.js";
import { removeFile, storeFile } from "./storage.js";
import {
  readEvidenceTimestampPolicy,
  timestampEvidenceManifest,
} from "./evidence-timestamp-core.js";
export {
  readEvidenceTimestampPolicy,
  timestampEvidenceManifest,
  verifyEvidenceTimestamp,
} from "./evidence-timestamp-core.js";
export type {
  ManifestTimestamp,
  EvidenceTimestampPolicy,
} from "./evidence-timestamp-core.js";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type TimestampDependencies = {
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
};
// One network attempt across worker processes and the manual operator CLI.
// A session advisory lock disappears on process/connection loss, so requests
// committed before a crash remain recoverable without a lease timeout.
const timestampLock = [1346457669, 1414745424] as const;
async function withTimestampLock<T>(operation: () => Promise<T>) {
  const connection = await pool.connect();
  let acquired = false;
  try {
    const result = await connection.query<{ acquired: boolean }>(
      "select pg_try_advisory_lock($1, $2) as acquired",
      timestampLock.slice(),
    );
    acquired = result.rows[0].acquired;
    if (!acquired) return { acquired: false as const };
    return { acquired: true as const, value: await operation() };
  } finally {
    let discard = false;
    try {
      if (acquired)
        await connection.query(
          "select pg_advisory_unlock($1, $2)",
          timestampLock.slice(),
        );
    } catch (error) {
      discard = true;
      throw error;
    } finally {
      connection.release(discard);
    }
  }
}

/** Called in the same document-lock transaction as canonical finalization. */
export async function requestEvidenceTimestamp(
  tx: Transaction,
  documentId: string,
  manifestSha256: string,
  policyPath: string,
) {
  await tx.execute(
    sql`select id from document where id = ${documentId} for update`,
  );
  const [existing] = await tx
    .select({ id: audit.id })
    .from(audit)
    .where(
      and(
        eq(audit.documentId, documentId),
        eq(audit.event, "evidence_timestamp_requested"),
      ),
    )
    .limit(1);
  if (existing) return;
  await tx.insert(audit).values({
    id: randomUUID(),
    documentId,
    actor: "system:evidence-timestamp",
    event: "evidence_timestamp_requested",
    details: { manifestSha256, policyPath },
  });
}

export async function recordEvidenceTimestampFailure(
  documentId: string,
  error: unknown,
) {
  if (error instanceof SealVerificationError && error.code === "TIMESTAMP_BUSY")
    return;
  // A bad operator document ID must not mask the original failure with a FK error.
  const [document] = await db
    .select({ id: documents.id })
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1);
  if (!document) return;
  await db.insert(audit).values({
    id: randomUUID(),
    documentId,
    actor: "system:evidence-timestamp",
    event: "evidence_timestamp_failed",
    details: {
      code:
        error instanceof SealVerificationError
          ? error.code
          : "timestamp_unavailable",
    },
  });
}

/** At most one pending attempt, with failures left for an explicit operator retry. */
export async function processPendingEvidenceTimestamp(
  dependencies: TimestampDependencies & { policyPath?: string } = {},
) {
  const result = await withTimestampLock(async () => {
    const pending = await db.execute<{
      document_id: string;
      details: { manifestSha256?: string; policyPath?: string };
    }>(sql`
      select request.document_id, request.details from audit_event request
      join document_export ready_export on ready_export.document_id=request.document_id and ready_export.canonical=true and ready_export.evidence_complete=true and ready_export.state='ready'
      where request.event='evidence_timestamp_requested'
      and not exists (select 1 from document_evidence_timestamp retained_timestamp where retained_timestamp.document_id=request.document_id)
      and not exists (select 1 from audit_event failure where failure.document_id=request.document_id and failure.event='evidence_timestamp_failed')
      order by request.created_at, request.id limit 1`);
    const request = pending.rows[0];
    if (!request) return { state: "idle" as const };
    try {
      const policyPath =
        dependencies.policyPath ?? config.EVIDENCE_TIMESTAMP_POLICY;
      if (!policyPath || policyPath !== request.details.policyPath)
        throw new SealVerificationError("TIMESTAMP_POLICY_UNAVAILABLE");
      const evidence = await completedEvidence(request.document_id);
      if (evidence.receipt.manifestSha256 !== request.details.manifestSha256)
        throw new SealVerificationError("TIMESTAMP_REQUEST_CHANGED");
      const timestamp = await prepareTimestamp(
        request.document_id,
        policyPath,
        dependencies,
      );
      return {
        state: "available" as const,
        documentId: request.document_id,
        timestamp,
      };
    } catch (error) {
      await recordEvidenceTimestampFailure(request.document_id, error);
      return { state: "failed" as const, documentId: request.document_id };
    }
  });
  return result.acquired ? result.value : { state: "busy" as const };
}

export async function timestampCompletedEvidence(
  documentId: string,
  policyPath: string,
  dependencies: TimestampDependencies = {},
) {
  const result = await withTimestampLock(async () => {
    try {
      return await prepareTimestamp(documentId, policyPath, dependencies);
    } catch (error) {
      // Persist failure before releasing the lock, so automatic recovery cannot
      // race a failed manual attempt and silently retry it.
      await recordEvidenceTimestampFailure(documentId, error);
      throw error;
    }
  });
  if (!result.acquired) throw new SealVerificationError("TIMESTAMP_BUSY");
  return result.value;
}

async function prepareTimestamp(
  documentId: string,
  policyPath: string,
  dependencies: TimestampDependencies,
) {
  const evidence = await completedEvidence(documentId);
  const [existing] = await db
    .select()
    .from(evidenceTimestamps)
    .where(eq(evidenceTimestamps.documentId, documentId));
  if (existing) {
    if (existing.manifestSha256 !== evidence.receipt.manifestSha256)
      throw new Error("Timestamp belongs to a different manifest.");
    await verifiedEvidenceFile(existing.fileKey, existing.sha256);
    return existing;
  }
  const policy = await readEvidenceTimestampPolicy(policyPath);
  const timestamp = await timestampEvidenceManifest(
    evidence.receipt.manifestSha256,
    policy,
    dependencies,
  );
  const bytes = Buffer.from(canonicalJson(timestamp));
  let uncommittedFile: string | undefined;
  try {
    const record = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select id from document where id = ${documentId} for update`,
      );
      const [old] = await tx
        .select()
        .from(evidenceTimestamps)
        .where(eq(evidenceTimestamps.documentId, documentId));
      if (old) return old;
      const current = await completedEvidence(documentId, tx);
      if (current.receipt.manifestSha256 !== timestamp.manifestSha256)
        throw new Error("The signing record changed while timestamping.");
      const [document] = await tx
        .select({ userId: documents.userId })
        .from(documents)
        .where(eq(documents.id, documentId));
      await tx.execute(
        sql`select id from "user" where id = ${document.userId} for update`,
      );
      await assertStorageBudget(document.userId, bytes.length, tx);
      const fileKey = await storeFile(bytes, "json");
      uncommittedFile = fileKey;
      const [created] = await tx
        .insert(evidenceTimestamps)
        .values({
          documentId,
          manifestSha256: timestamp.manifestSha256,
          fileKey,
          sha256: evidenceHash(bytes),
        })
        .returning();
      await tx.insert(audit).values({
        id: randomUUID(),
        documentId,
        actor: "system:evidence-timestamp",
        event: "evidence_timestamped",
        details: {
          manifestSha256: timestamp.manifestSha256,
          timestampSha256: created.sha256,
          genTime: timestamp.genTime,
          tsaFingerprint: timestamp.tsaFingerprint,
        },
      });
      return created;
    });
    uncommittedFile = undefined;
    return record;
  } finally {
    if (uncommittedFile) await removeFile(uncommittedFile);
  }
}
