import { parseArgs } from "node:util";
import {
  planDocumentDeletion,
  applyDocumentDeletion,
  resumeDocumentCleanup,
} from "../server/deletion.js";
import { pool } from "../server/db.js";
const { values } = parseArgs({
  options: {
    document: { type: "string" },
    actor: { type: "string" },
    execute: { type: "boolean", default: false },
    cleanup: { type: "boolean", default: false },
    fingerprint: { type: "string" },
    reason: { type: "string" },
  },
  strict: true,
});
try {
  if (
    !values.document ||
    !/^[a-f0-9-]{36}$/.test(values.document) ||
    !values.actor
  )
    throw new Error(
      "Supply --document UUID and --actor ADMIN_USER_ID. Without --execute this only prints a reviewable deletion plan.",
    );
  if (values.cleanup) {
    if (values.execute || !values.fingerprint)
      throw new Error(
        "Use --cleanup with the approved --fingerprint and without --execute to resume an already completed deletion.",
      );
    const result = await resumeDocumentCleanup(
      values.document,
      values.actor,
      values.fingerprint,
    );
    console.log(JSON.stringify(result, null, 2));
    if (result.cleanupRequired.length) process.exitCode = 1;
  } else if (values.execute) {
    if (
      !values.fingerprint ||
      !/^[a-f0-9]{64}$/.test(values.fingerprint) ||
      !values.reason
    )
      throw new Error(
        "Execution requires the reviewed --fingerprint and a --reason. Obtain explicit approval for this exact permanent deletion first.",
      );
    const result = await applyDocumentDeletion(
      values.document,
      values.actor,
      values.fingerprint,
      values.reason,
    );
    console.log(JSON.stringify(result, null, 2));
    if (result.cleanupRequired.length) process.exitCode = 1;
  } else
    console.log(
      JSON.stringify(
        await planDocumentDeletion(values.document, values.actor),
        null,
        2,
      ),
    );
} catch (error) {
  console.error(error instanceof Error ? error.message : "Deletion failed");
  process.exitCode = 1;
} finally {
  await pool.end();
}
