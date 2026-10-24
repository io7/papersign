import { eq, and, sql, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db, pool } from "./db.js";
import { exportsTable, audit, documents } from "./schema.js";
import { queue, startQueue } from "./queue.js";
import { renderPdf } from "./pdf.js";
import { storeFile, sha256, removeFile } from "./storage.js";
import { requestCertificateSeal } from "./seal-client.js";
import {
  completedEvidence,
  recordFinalization,
  verifiedEvidenceFile,
} from "./evidence.js";
import { assertStorageBudget } from "./storage-usage.js";
import { workerHeartbeat } from "./operations.js";
import { config } from "./config.js";
import {
  requestEvidenceTimestamp,
  processPendingEvidenceTimestamp,
} from "./evidence-timestamp.js";
await startQueue();
await queue.work<{ exportId: string }>(
  "pdf-export",
  { batchSize: 1, pollingIntervalSeconds: 1 },
  async (jobs) => {
    for (const job of jobs) {
      const record = await db.query.exportsTable.findFirst({
        where: eq(exportsTable.id, job.data.exportId),
      });
      if (!record || record.state === "ready") continue;
      const claimed = await db
        .update(exportsTable)
        .set({ state: "working", error: null, startedAt: new Date() })
        .where(
          and(
            eq(exportsTable.id, record.id),
            inArray(exportsTable.state, ["queued", "failed"]),
          ),
        )
        .returning({ id: exportsTable.id });
      if (!claimed.length) continue;
      let uncommittedFile: string | undefined;
      try {
        if (record.canonical && !record.sourceFiles.length)
          throw new Error(
            "The canonical PDF is missing its frozen source hashes.",
          );
        for (const file of record.sourceFiles)
          await verifiedEvidenceFile(file.fileKey, file.sha256);
        const rendered = await renderPdf(
          record.originalKey,
          record.layers,
          record.rasterize,
        );
        const sealed = record.sealPolicyId
          ? await requestCertificateSeal(rendered, record.sealPolicyId)
          : null;
        const bytes = sealed?.bytes ?? rendered;
        await db.transaction(async (tx) => {
          await tx.execute(
            sql`select id from document where id = ${record.documentId} for update`,
          );
          const [document] = await tx
            .select({ userId: documents.userId })
            .from(documents)
            .where(eq(documents.id, record.documentId));
          if (!document) throw new Error("Document not found.");
          await tx.execute(
            sql`select id from "user" where id = ${document.userId} for update`,
          );
          await assertStorageBudget(document.userId, bytes.length, tx);
          const fileKey = await storeFile(bytes, "pdf");
          uncommittedFile = fileKey;
          const updated = await tx
            .update(exportsTable)
            .set({
              state: "ready",
              fileKey,
              sha256: sha256(bytes),
              seal: sealed?.report ?? null,
            })
            .where(
              and(
                eq(exportsTable.id, record.id),
                eq(exportsTable.state, "working"),
              ),
            )
            .returning({ id: exportsTable.id });
          if (!updated.length)
            throw new Error(
              "PDF processing was interrupted. Prepare the download again.",
            );
          if (record.canonical) {
            await recordFinalization(tx, record, { fileKey, bytes });
            // Check the entire portable record before committing any ready artifact.
            if (record.evidenceComplete) {
              const evidence = await completedEvidence(record.documentId, tx, {
                verifyStoredFiles: true,
              });
              if (config.EVIDENCE_TIMESTAMP_POLICY)
                await requestEvidenceTimestamp(
                  tx,
                  record.documentId,
                  evidence.receipt.manifestSha256,
                  config.EVIDENCE_TIMESTAMP_POLICY,
                );
            }
          }
          await tx.insert(audit).values({
            id: randomUUID(),
            documentId: record.documentId,
            actor: "system:pdf-worker",
            event: "export_finalized",
            details: {
              exportId: record.id,
              revision: record.revision,
              canonical: record.canonical,
              evidenceComplete: record.evidenceComplete,
              rasterize: record.rasterize,
              sha256: sha256(bytes),
              sealPolicyId: record.sealPolicyId,
            },
          });
          if (sealed)
            await tx.insert(audit).values({
              id: randomUUID(),
              documentId: record.documentId,
              actor: "system:certificate-sealer",
              event: "certificate_sealed",
              details: {
                exportId: record.id,
                policyId: record.sealPolicyId,
                sha256: sha256(bytes),
                ...sealed.report,
              },
            });
        });
        uncommittedFile = undefined;
      } catch (error) {
        if (uncommittedFile) await removeFile(uncommittedFile);
        await db
          .update(exportsTable)
          .set({
            state: "failed",
            error:
              error instanceof Error
                ? error.message.slice(0, 300)
                : "Export failed. Try again.",
          })
          .where(
            and(
              eq(exportsTable.id, record.id),
              eq(exportsTable.state, "working"),
            ),
          );
        throw error;
      }
    }
  },
);
// Reconcile the durable export outbox after a web/worker restart or transient queue outage.
async function reconcile() {
  await workerHeartbeat();
  await db
    .update(exportsTable)
    .set({
      state: "failed",
      error: "PDF processing was interrupted. Prepare the download again.",
    })
    .where(
      and(
        eq(exportsTable.state, "working"),
        sql`${exportsTable.startedAt} < now() - interval '15 minutes'`,
      ),
    );
  const pending = await db
    .select({ id: exportsTable.id })
    .from(exportsTable)
    .where(eq(exportsTable.state, "queued"))
    .limit(100);
  for (const item of pending)
    await queue.send(
      "pdf-export",
      { exportId: item.id },
      { singletonKey: item.id },
    );
  // Requests committed with ready PDFs survive a crash before/during timestamping.
  // The advisory lock serializes bounded attempts across worker processes.
  const timestamp = await processPendingEvidenceTimestamp();
  if (timestamp.state === "failed")
    console.error(
      "PaperSign evidence timestamp failed; the completed PDF is preserved.",
    );
}
await reconcile();
const timer = setInterval(
  () => reconcile().catch((err) => console.error(err.message)),
  10000,
);
console.log("PaperSign PDF worker ready.");
async function stop() {
  clearInterval(timer);
  await queue.stop();
  await pool.end();
  process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
