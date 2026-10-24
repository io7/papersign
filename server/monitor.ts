import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { operationalChecks } from "./operations.js";
import { config } from "./config.js";
import { pool } from "./db.js";

const checks = await operationalChecks(true);
try {
  const response = await fetch(`${config.APP_URL}/api/health`, {
    signal: AbortSignal.timeout(10_000),
    redirect: "error",
  });
  const body = await response.json();
  checks.push({
    name: "public-https",
    ok: response.ok && body.status === "ok",
    detail: "Public application health",
  });
} catch {
  checks.push({
    name: "public-https",
    ok: false,
    detail: "Public application unreachable",
  });
}
const failed = checks.filter((check) => !check.ok),
  state =
    failed
      .map((check) => check.name)
      .sort()
      .join(",") || "ok";
console.log(
  JSON.stringify({
    status: state === "ok" ? "ok" : "failed",
    checkedAt: new Date().toISOString(),
    checks,
  }),
);
const statePath = join(config.DATA_DIR, "monitor-state.json");
let previous: { state: string; sentAt: number } | undefined;
try {
  previous = JSON.parse(await readFile(statePath, "utf8"));
} catch {
  /* first run */
}
if (
  config.ALERT_WEBHOOK_URL &&
  (previous?.state !== state ||
    (failed.length && Date.now() - (previous?.sentAt ?? 0) > 3600_000))
) {
  try {
    const response = await fetch(config.ALERT_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        service: "PaperSign",
        status: state === "ok" ? "recovered" : "failed",
        checks,
      }),
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
    if (!response.ok) throw new Error("Alert delivery failed");
    await writeFile(statePath, JSON.stringify({ state, sentAt: Date.now() }), {
      mode: 0o600,
    });
  } catch {
    console.error("PaperSign monitoring alert could not be delivered.");
    process.exitCode = 1;
  }
}
await pool.end();
if (failed.length) process.exitCode = 1;
