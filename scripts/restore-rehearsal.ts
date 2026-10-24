import { randomBytes } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  copyFile,
  stat,
  chmod,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { createServer } from "node:net";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";
import { restoreConnection } from "./restore-safety.js";
import { evidenceHash } from "../server/evidence-core.js";
import { verifyEvidenceDirectory } from "../server/evidence-verifier.js";

try {
  process.loadEnvFile();
} catch {
  /* Explicit environment works too. */
}
const base = process.env.DATABASE_URL;
if (!base)
  throw new Error(
    "Set DATABASE_URL to an isolated loopback PostgreSQL server.",
  );
if (
  process.env.SEAL_SOCKET ||
  process.env.SEAL_POLICY_ID ||
  process.env.EVIDENCE_TIMESTAMP_POLICY
)
  throw new Error(
    "Run restore rehearsals with an isolated development configuration that has certificate and timestamp providers disabled.",
  );
const suffix = randomBytes(12).toString("hex"),
  sourceName = `papersign_restore_source_${suffix}`,
  targetName = `papersign_restore_${suffix}`;
const source = restoreConnection(base, sourceName),
  target = restoreConnection(base, targetName);
const adminUrl = new URL(source);
adminUrl.pathname = "/postgres";
const admin = new pg.Client({ connectionString: adminUrl.toString() });
const output = resolve(
  process.env.RESTORE_OUTPUT_ROOT ?? ".local/qa/readiness",
);
const directory = join(output, `restore-${suffix}`),
  sourceFiles = join(directory, "source-files"),
  targetFiles = join(directory, "restored-files"),
  backupFiles = join(directory, "backup-files");
const fixtureReport = join(directory, "fixture.json"),
  backup = join(directory, "papersign.dump"),
  secretFile = join(directory, "BETTER_AUTH_SECRET");
const secret = randomBytes(48).toString("base64url"),
  password = `Restore-${randomBytes(24).toString("base64url")}!`,
  email = `restore-${suffix}@example.invalid`;
const execute = promisify(execFile),
  children: ChildProcess[] = [],
  created: string[] = [];
const report: Record<string, unknown> = {
  scope: "synthetic-local-only",
  startedAt: new Date().toISOString(),
  sourceDatabase: sourceName,
  restoredDatabase: targetName,
  directory,
  productionBackupTested: false,
};
let stage = "initialization",
  adminConnected = false;
const processEnv = (url: URL, dataDir: string, appUrl: string) => ({
  ...process.env,
  DATABASE_URL: url.toString(),
  DATA_DIR: dataDir,
  BETTER_AUTH_SECRET: secret,
  APP_URL: appUrl,
  HOST: "127.0.0.1",
  REGISTRATION_ENABLED: "true",
  SMTP_HOST: "",
  SMTP_FROM: "",
  SMTP_USER: "",
  SMTP_PASSWORD: "",
  SEAL_SOCKET: undefined,
  SEAL_POLICY_ID: undefined,
  RESTORE_FIXTURE_REPORT: fixtureReport,
  RESTORE_TEST_EMAIL: email,
  RESTORE_TEST_PASSWORD: password,
  RESTORE_OUTPUT_DIR: directory,
});
const pgEnv = (url: URL) => ({
  ...process.env,
  PGHOST: url.hostname,
  PGPORT: url.port || "5432",
  PGUSER: decodeURIComponent(url.username),
  PGPASSWORD: decodeURIComponent(url.password),
  PGDATABASE: url.pathname.slice(1),
});
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function command(binary: string, args: string[], env: NodeJS.ProcessEnv) {
  return execute(binary, args, {
    env,
    timeout: 120000,
    maxBuffer: 1024 * 1024,
  });
}
async function freePort() {
  const server = createServer();
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", done);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No local port available.");
  await new Promise<void>((done, reject) =>
    server.close((error) => (error ? reject(error) : done())),
  );
  return address.port;
}
function launch(script: string, env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ["--import", "tsx", script], {
    env,
    stdio: ["ignore", "ignore", "ignore"],
  });
  children.push(child);
  return child;
}
async function stopChildren() {
  await Promise.all(
    children.map(async (child) => {
      if (child.exitCode !== null || child.signalCode) return;
      child.kill("SIGTERM");
      for (
        let attempt = 0;
        attempt < 40 && child.exitCode === null && !child.signalCode;
        attempt++
      )
        await pause(100);
      if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
    }),
  );
}
try {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await mkdir(backupFiles, { mode: 0o700 });
  await mkdir(targetFiles, { mode: 0o700 });
  await writeFile(secretFile, secret, { mode: 0o600, flag: "wx" });
  if (((await stat(secretFile)).mode & 0o777) !== 0o600)
    throw new Error("The recovery secret is not private.");
  await admin.connect();
  adminConnected = true;
  stage = "creating fresh source database";
  for (const name of [sourceName, targetName]) {
    restoreConnection(base, name);
    const existing = await admin.query(
      "select 1 from pg_database where datname = $1",
      [name],
    );
    if (existing.rowCount)
      throw new Error("Refusing to overwrite an existing restore database.");
    await admin.query(`CREATE DATABASE "${name}"`);
    created.push(name);
  }
  const sourceEnv = processEnv(source, sourceFiles, "http://127.0.0.1:3199");
  stage = "migrating synthetic source";
  await command(
    process.execPath,
    ["--import", "tsx", "server/migrate.ts"],
    sourceEnv,
  );
  stage = "creating synthetic recovery fixture";
  await command(
    process.execPath,
    ["--import", "tsx", "scripts/restore-fixture.ts", "seed"],
    sourceEnv,
  );
  const fixture = JSON.parse(await readFile(fixtureReport, "utf8"));
  stage = "taking real PostgreSQL custom-format dump";
  const dumpTool = process.env.PG_DUMP ?? "pg_dump",
    restoreTool = process.env.PG_RESTORE ?? "pg_restore";
  const dumpVersion = await command(dumpTool, ["--version"], pgEnv(source));
  report.pgDumpVersion = dumpVersion.stdout.trim();
  await command(
    dumpTool,
    ["--format=custom", "--no-owner", "--no-acl", `--file=${backup}`],
    pgEnv(source),
  );
  await chmod(backup, 0o600);
  const seen = new Set<string>();
  for (const file of fixture.files) {
    if (!/^[a-f0-9-]{36}\.(pdf|png|json)$/.test(file.fileKey))
      throw new Error("Unsafe fixture storage key.");
    if (seen.has(file.fileKey)) continue;
    seen.add(file.fileKey);
    const bytes = await readFile(join(sourceFiles, file.fileKey));
    if (evidenceHash(bytes) !== file.sha256)
      throw new Error("Source fixture file changed before backup.");
    await copyFile(
      join(sourceFiles, file.fileKey),
      join(backupFiles, file.fileKey),
    );
    await copyFile(
      join(backupFiles, file.fileKey),
      join(targetFiles, file.fileKey),
    );
  }
  report.backup = {
    file: backup,
    sha256: evidenceHash(await readFile(backup)),
    size: (await stat(backup)).size,
    referencedFiles: seen.size,
    secretMode: "0600",
  };
  stage = "restoring into fresh target database";
  await command(
    restoreTool,
    [
      "--exit-on-error",
      "--single-transaction",
      "--no-owner",
      "--no-acl",
      `--dbname=${targetName}`,
      backup,
    ],
    pgEnv(target),
  );
  const port = await freePort(),
    appUrl = `http://127.0.0.1:${port}`;
  const restoredSecret = await readFile(secretFile, "utf8");
  const targetEnv = {
    ...processEnv(target, targetFiles, appUrl),
    BETTER_AUTH_SECRET: restoredSecret,
    PORT: String(port),
  };
  stage = "verifying restored metadata and evidence";
  await command(
    process.execPath,
    ["--import", "tsx", "server/migrate.ts"],
    targetEnv,
  );
  await command(
    process.execPath,
    ["--import", "tsx", "scripts/restore-fixture.ts", "verify"],
    targetEnv,
  );
  const packageDirectory = join(directory, "evidence-package");
  await mkdir(packageDirectory, { mode: 0o700 });
  await command(
    "tar",
    ["-xf", join(directory, "restored-evidence.tar"), "-C", packageDirectory],
    process.env,
  );
  const verified = await verifyEvidenceDirectory(
    packageDirectory,
    fixture.receipt.manifestSha256,
    fixture.acceptanceHash,
  );
  await command(
    process.execPath,
    [
      join(packageDirectory, "verify.mjs"),
      packageDirectory,
      "--receipt",
      fixture.receipt.manifestSha256,
    ],
    { ...process.env, NODE_OPTIONS: "" },
  );
  report.evidence = {
    filesVerified: verified.filesVerified,
    receiptFingerprint: fixture.receipt.manifestSha256,
    acceptanceFingerprint: fixture.acceptanceHash,
    offlineNodeVerifier: "passed",
    pendingInvitationDecryption: "passed",
  };
  stage = "starting restored service and signing in";
  const web = launch("server/index.ts", targetEnv);
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (web.exitCode !== null)
      throw new Error("The restored web service stopped unexpectedly.");
    try {
      if ((await fetch(appUrl + "/api/health")).ok) {
        ready = true;
        break;
      }
    } catch {
      /* local startup */
    }
    await pause(100);
  }
  if (!ready) throw new Error("The restored web service did not become ready.");
  const login = await fetch(appUrl + "/api/auth/sign-in/email", {
    method: "POST",
    headers: {
      Origin: appUrl,
      "X-PaperSign": "1",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, password }),
  });
  if (!login.ok)
    throw new Error("Login with the restored synthetic account failed.");
  const cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  if (!cookie) throw new Error("Restored login did not establish a session.");
  report.serviceLogin = "passed";
  stage = "resuming the durable export queue";
  const worker = launch("server/worker.ts", targetEnv);
  const restored = new pg.Client({ connectionString: target.toString() });
  await restored.connect();
  try {
    let exportRow:
      { state: string; sha256: string; file_key: string } | undefined;
    for (let attempt = 0; attempt < 200; attempt++) {
      if (worker.exitCode !== null)
        throw new Error("The restored worker stopped unexpectedly.");
      exportRow = (
        await restored.query(
          "select state, sha256, file_key from document_export where id = $1",
          [fixture.queuedExportId],
        )
      ).rows[0];
      if (exportRow?.state === "ready") break;
      if (exportRow?.state === "failed")
        throw new Error("The restored queued export failed.");
      await pause(100);
    }
    if (exportRow?.state !== "ready")
      throw new Error("The restored durable export did not resume.");
    const download = await fetch(
      appUrl + `/api/exports/${fixture.queuedExportId}/download`,
      { headers: { Cookie: cookie } },
    );
    if (
      !download.ok ||
      evidenceHash(new Uint8Array(await download.arrayBuffer())) !==
        exportRow.sha256
    )
      throw new Error("The resumed export download failed its hash check.");
    const canonical = (
      await restored.query(
        "select sha256 from document_export where document_id = $1 and canonical = true",
        [fixture.documentId],
      )
    ).rows[0];
    if (canonical.sha256 !== fixture.receipt.finalPdfSha256)
      throw new Error("Worker recovery changed the canonical final PDF.");
    report.workerRecovery = {
      state: "passed",
      queuedExportSha256: exportRow.sha256,
      canonicalUnchanged: true,
    };
    let partial:
      { state: string; sha256: string; evidence_complete: boolean } | undefined;
    for (let attempt = 0; attempt < 200; attempt++) {
      partial = (
        await restored.query(
          "select state, sha256, evidence_complete from document_export where id = $1",
          [fixture.partialExportId],
        )
      ).rows[0];
      if (partial?.state === "ready") break;
      if (partial?.state === "failed")
        throw new Error("The in-flight legacy workflow failed finalization.");
      await pause(100);
    }
    if (partial?.state !== "ready" || partial.evidence_complete !== false)
      throw new Error(
        "The in-flight legacy workflow was not restored as an explicitly partial record.",
      );
    const partialDownload = await fetch(
      appUrl + `/api/exports/${fixture.partialExportId}/download`,
      { headers: { Cookie: cookie } },
    );
    if (
      !partialDownload.ok ||
      evidenceHash(new Uint8Array(await partialDownload.arrayBuffer())) !==
        partial.sha256
    )
      throw new Error(
        "The in-flight legacy final PDF could not be downloaded intact.",
      );
    await command(
      process.execPath,
      ["--import", "tsx", "scripts/restore-fixture.ts", "verify-partial"],
      targetEnv,
    );
    report.inFlightLegacyWorkflow = {
      canonicalPdfReady: true,
      downloadHashVerified: true,
      evidenceComplete: false,
      historicalConsentFabricated: false,
      completePackageRejected: true,
    };
    report.migrations = (
      await restored.query(
        "select count(*)::int as count from drizzle.__drizzle_migrations",
      )
    ).rows[0].count;
  } finally {
    await restored.end();
  }
  report.result = "passed";
} catch (error) {
  report.result = "failed";
  report.failedStage = stage;
  let message =
    error instanceof Error ? error.message : "Unknown rehearsal failure";
  for (const sensitive of [
    secret,
    password,
    decodeURIComponent(source.password),
    source.toString(),
    target.toString(),
  ])
    if (sensitive) message = message.replaceAll(sensitive, "[redacted]");
  report.error = message.slice(0, 2000);
  process.exitCode = 1;
} finally {
  await stopChildren();
  if (adminConnected) {
    const cleaned: string[] = [];
    for (const name of created.reverse()) {
      restoreConnection(base, name);
      await admin.query(
        "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
        [name],
      );
      await admin.query(`DROP DATABASE "${name}"`);
      cleaned.push(name);
    }
    report.cleanedDatabases = cleaned;
    report.cleanupVerified =
      (
        await admin.query(
          "select datname from pg_database where datname = any($1)",
          [created],
        )
      ).rowCount === 0;
    await admin.end();
  }
  report.finishedAt = new Date().toISOString();
  await mkdir(output, { recursive: true, mode: 0o700 });
  await writeFile(
    join(output, "restore-report.json"),
    JSON.stringify(report, null, 2) + "\n",
    { mode: 0o600 },
  );
  console.log(JSON.stringify(report, null, 2));
}
