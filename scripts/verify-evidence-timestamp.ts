import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { X509Certificate } from "node:crypto";
import { verifyEvidenceDirectory } from "../server/evidence-verifier.js";
import {
  verifyEvidenceTimestamp,
  type ManifestTimestamp,
} from "../server/evidence-timestamp-core.js";
const [directory, ...rootPaths] = process.argv.slice(2);
if (!directory || !rootPaths.length)
  throw new Error(
    "Usage: node --import tsx scripts/verify-evidence-timestamp.ts <extracted-package> <independently-trusted-root.pem-or.der> [...roots]",
  );
try {
  const evidence = await verifyEvidenceDirectory(directory);
  const bytes = await readFile(join(directory, "timestamp.json"));
  if (bytes.length > 100 * 1024 * 1024)
    throw new Error("Timestamp bundle too large.");
  const timestamp = JSON.parse(bytes.toString("utf8")) as ManifestTimestamp;
  const roots = await Promise.all(
    rootPaths.map(
      async (path) => new X509Certificate(await readFile(path)).raw,
    ),
  );
  console.log(
    JSON.stringify(
      await verifyEvidenceTimestamp(
        timestamp,
        evidence.receipt.manifestSha256,
        roots,
      ),
      null,
      2,
    ),
  );
} catch (error) {
  console.error(`Timestamp verification FAILED: ${(error as Error).message}`);
  process.exitCode = 1;
}
