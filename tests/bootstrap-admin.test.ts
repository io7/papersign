import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { Client } from "pg";
import { config } from "../server/config";

// Runs the first-Admin command against the disposable local database only.
// The synthetic accounts are demoted again afterwards.
const runFile = promisify(execFile);
const database = new Client({ connectionString: config.DATABASE_URL });
const run = randomUUID().slice(0, 8);
const accounts = ["first", "second"].map((label) => ({
  id: randomUUID(),
  email: `bootstrap-${label}-${run}@example.invalid`,
}));

async function bootstrap(...args: string[]) {
  try {
    const { stdout } = await runFile(
      process.execPath,
      ["--import", "tsx", "scripts/bootstrap-admin.ts", ...args],
      { timeout: 60_000 },
    );
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };
    return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
  }
}
const role = async (id: string) =>
  (await database.query('select role from "user" where id = $1', [id])).rows[0]
    .role;

describe("first Admin command", () => {
  beforeAll(async () => {
    const url = new URL(config.DATABASE_URL);
    expect([url.hostname, url.port]).toEqual(["127.0.0.1", "54376"]);
    await database.connect();
    const admins = await database.query(
      'select count(*)::int count from "user" where role = $1',
      ["admin"],
    );
    expect(admins.rows[0].count, "needs a database without Admins").toBe(0);
    for (const account of accounts)
      await database.query(
        'insert into "user" (id, name, email) values ($1, $2, $3)',
        [account.id, "Bootstrap QA", account.email],
      );
  });
  afterAll(async () => {
    try {
      await database.query(
        'update "user" set role = $1 where id = any($2::text[])',
        ["user", accounts.map((account) => account.id)],
      );
    } finally {
      await database.end();
    }
  });

  it("refuses unknown emails, mismatched IDs and malformed arguments", async () => {
    const usage = await bootstrap("--email");
    expect(usage.code).toBe(1);
    expect(usage.stderr).toMatch(/Usage/);
    const unknown = await bootstrap("--email", `nobody-${run}@example.invalid`);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toMatch(/no User account has exactly this email/);
    const wrongCase = await bootstrap(
      "--email",
      accounts[0].email.toUpperCase(),
    );
    expect(wrongCase.code).toBe(1);
    const mismatch = await bootstrap(
      "--user-id",
      accounts[1].id,
      "--email",
      accounts[0].email,
    );
    expect(mismatch.code).toBe(1);
    expect(mismatch.stderr).toMatch(/exact User ID, email/);
    expect(await role(accounts[0].id)).toBe("user");
    expect(await role(accounts[1].id)).toBe("user");
  });

  it("promotes exactly one account by email, records it, and refuses a second Admin", async () => {
    const promoted = await bootstrap("--email", accounts[0].email);
    expect(promoted.code, promoted.stderr).toBe(0);
    expect(JSON.parse(promoted.stdout)).toEqual({
      id: accounts[0].id,
      email: accounts[0].email,
      role: "admin",
    });
    expect(await role(accounts[0].id)).toBe("admin");
    const event = await database.query(
      "select details from admin_event where event = $1 and target_id = $2",
      ["first_admin_bootstrapped", accounts[0].id],
    );
    expect(event.rows[0].details.method).toBe("operator_cli");
    const second = await bootstrap("--email", accounts[1].email);
    expect(second.code).toBe(1);
    expect(second.stderr).toMatch(/an Admin already exists/);
    expect(await role(accounts[1].id)).toBe("user");
  });
});
