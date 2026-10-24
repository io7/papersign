import { createHmac } from "node:crypto";
import { Client } from "pg";
import { config } from "../../server/config.js";

// Workflow fixtures are intentionally separate from the tests that exercise
// real mailed verification links. This helper can touch only exact synthetic
// identities in the disposable developer database, never production accounts.
export async function verifyFixtureEmail(id: string, email: string) {
  const url = new URL(config.DATABASE_URL);
  if (
    url.hostname !== "127.0.0.1" ||
    url.port !== "54376" ||
    !/@example\.(invalid|test)$/.test(email)
  )
    throw new Error(
      "Fixture verification is limited to synthetic accounts in local PostgreSQL:54376.",
    );
  const database = new Client({ connectionString: config.DATABASE_URL });
  await database.connect();
  try {
    const result = await database.query(
      'update "user" set email_verified = true where id = $1 and email = $2 returning id',
      [id, email],
    );
    if (result.rowCount !== 1)
      throw new Error("Exact test account was not found.");
  } finally {
    await database.end();
  }
}
export function fixtureTotp(uri: string) {
  const encoded = new URL(uri).searchParams.get("secret")!;
  let bits = "";
  for (const char of encoded.replace(/=+$/, ""))
    bits += "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
      .indexOf(char.toUpperCase())
      .toString(2)
      .padStart(5, "0");
  const key = Buffer.from(
    bits.match(/.{8}/g)!.map((byte) => parseInt(byte, 2)),
  );
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const hash = createHmac("sha1", key).update(counter).digest();
  const offset = hash.at(-1)! & 15;
  return String((hash.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(
    6,
    "0",
  );
}
