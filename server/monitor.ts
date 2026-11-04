import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hostname } from "node:os";
import { operationalChecks } from "./operations.js";
import { config } from "./config.js";
import { pool } from "./db.js";
import { sendAlertMail } from "./mail.js";
import { setAlertSource } from "./alerts.js";
setAlertSource("monitor");

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
// Alert when the state changes, and hourly while checks keep failing. A first
// run that finds everything working only records the state.
const due =
  previous?.state !== state ||
  (failed.length > 0 && Date.now() - (previous?.sentAt ?? 0) > 3600_000);
const firstRunOk = !previous && state === "ok";
const alerting = Boolean(config.ALERT_WEBHOOK_URL || config.ERROR_ALERT_EMAIL);
const saveState = () =>
  writeFile(statePath, JSON.stringify({ state, sentAt: Date.now() }), {
    mode: 0o600,
  });
if (due && alerting && firstRunOk) await saveState();
else if (due && alerting) {
  let delivered = false;
  if (config.ALERT_WEBHOOK_URL) {
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
      delivered = true;
    } catch {
      console.error("PaperSign monitoring alert could not be delivered.");
      process.exitCode = 1;
    }
  }
  if (config.ERROR_ALERT_EMAIL) {
    const host = new URL(config.APP_URL).host;
    const lines = checks.map(
      (check) => `${check.ok ? "ok    " : "FAILED"} ${check.name}: ${check.detail}`,
    );
    try {
      await sendAlertMail({
        to: config.ERROR_ALERT_EMAIL,
        subject:
          state === "ok"
            ? `[PaperSign] Health checks recovered on ${host}`
            : `[PaperSign] Health checks failing on ${host}: ${state}`,
        text: [
          state === "ok"
            ? `All PaperSign health checks pass again on ${host}.`
            : `PaperSign health checks are failing on ${host}.`,
          "",
          ...lines,
          "",
          `Checked ${new Date().toISOString()} on ${hostname()}.`,
          state === "ok"
            ? ""
            : "You will get this email every hour until the checks pass.",
        ].join("\n"),
      });
      delivered = true;
    } catch (error) {
      console.error(
        `PaperSign monitoring email could not be delivered: ${(error as Error).message}`,
      );
      process.exitCode = 1;
    }
  }
  if (delivered) await saveState();
}
await pool.end();
if (failed.length) process.exitCode = 1;
