import { stat } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { db } from "./db.js";
import { config } from "./config.js";
import { filePath } from "./storage.js";

type Reader = Pick<typeof db, "execute">;
// Count every retained file once, including trash, earlier exports, and evidence.
// Callers adding files hold the owner's row lock until the new references commit.
export async function accountStorageBytes(userId: string, reader: Reader = db) {
  const result = await reader.execute<{ key: string }>(sql`
    with owned as (select id, file_key, preview_key from document where user_id = ${userId})
    select file_key as key from owned
    union select preview_key from owned where preview_key is not null
    union select file_key from signature where user_id = ${userId}
    union select image_key from invitation where document_id in (select id from owned) and image_key is not null
    union select file_key from document_export where document_id in (select id from owned) and file_key is not null
    union select f->>'fileKey' from evidence_record, jsonb_array_elements(files) f where document_id in (select id from owned)
    union select f->>'fileKey' from document_export, jsonb_array_elements(source_files) f where document_id in (select id from owned)
    union select file_key from document_evidence_timestamp where document_id in (select id from owned) and file_key is not null
  `);
  let bytes = 0;
  const keys = result.rows.map((row) => row.key).filter(Boolean);
  for (let offset = 0; offset < keys.length; offset += 16) {
    const sizes = await Promise.all(
      keys
        .slice(offset, offset + 16)
        .map(async (key) => (await stat(filePath(key))).size),
    );
    bytes += sizes.reduce((sum, size) => sum + size, 0);
  }
  return bytes;
}
export async function assertStorageBudget(
  userId: string,
  additionalBytes: number,
  reader: Reader = db,
) {
  const used = await accountStorageBytes(userId, reader);
  if (used + additionalBytes > config.ACCOUNT_STORAGE_LIMIT_BYTES)
    throw Object.assign(
      new Error(
        "Your account storage is full. Retained PDFs, signatures and signing records count towards the limit. Contact the operator before adding more files.",
      ),
      { statusCode: 413, publicError: true },
    );
  return used;
}
export async function assertExportBudget(userId: string, reader: Reader = db) {
  const result = await reader.execute<{ count: number }>(
    sql`select count(*)::int as count from document_export e join document d on d.id = e.document_id where d.user_id = ${userId} and e.state in ('queued','working')`,
  );
  if (result.rows[0].count >= config.MAX_ACTIVE_EXPORTS)
    throw Object.assign(
      new Error(
        "Your account already has PDFs being prepared. Wait for them to finish and try again.",
      ),
      { statusCode: 429, publicError: true },
    );
}
