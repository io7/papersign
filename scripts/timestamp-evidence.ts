import { timestampCompletedEvidence } from "../server/evidence-timestamp.js";
import { pool } from "../server/db.js";
import { SealVerificationError } from "../server/sealing/types.js";
const [documentId, policyPath] = process.argv.slice(2);
if (!/^[a-f0-9-]{36}$/.test(documentId ?? "") || !policyPath)
  throw new Error(
    "Usage: node --import tsx scripts/timestamp-evidence.ts <document-id> <operator-policy.json>",
  );
try {
  const record = await timestampCompletedEvidence(documentId, policyPath);
  console.log(
    JSON.stringify(
      {
        documentId,
        manifestSha256: record.manifestSha256,
        timestampSha256: record.sha256,
        createdAt: record.createdAt,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    error instanceof SealVerificationError && error.code === "TIMESTAMP_BUSY"
      ? "Another evidence timestamp is being prepared. Retry this command after it finishes."
      : "The evidence timestamp could not be prepared. The existing final PDF and acceptance records are preserved.",
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
