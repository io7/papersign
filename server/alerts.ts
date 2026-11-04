import { hostname } from "node:os";
import { config } from "./config.js";
import { sendAlertMail } from "./mail.js";

/**
 * Operator error alerts. Every report becomes one JSON line on stderr (the
 * service log). With ERROR_ALERT_EMAIL set, it is also emailed: the first of
 * each kind at once, later ones of the same kind summed up at most every
 * 15 minutes, and never more than 30 alert emails an hour per process.
 * Alerts carry no signing links, tokens, passwords or document content.
 */
type Value = string | number | boolean | null | undefined;
export type AlertDetail = Record<string, Value>;

const THROTTLE_MS = 15 * 60_000;
const MAX_EMAILS_PER_HOUR = 30;

let source = "web";
/** Names the process in alerts: web, worker or monitor. */
export function setAlertSource(name: string) {
  source = name;
}

type Pending = { summary: string; detail: AlertDetail; at: Date };
type KindState = {
  lastSentAt: number;
  suppressed: number;
  latest?: Pending;
  timer?: ReturnType<typeof setTimeout>;
};
const kinds = new Map<string, KindState>();
let sentAt: number[] = [];

/** Removes line breaks, signing-link tokens and API keys from a value and bounds its length. */
export function scrub(value: unknown): string {
  return String(value ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/psk_[A-Za-z0-9_-]+/g, "psk_[redacted]")
    .replace(
      /\/(sign|join|account-invitations|reset-password)\/[^\s/?"']+/g,
      "/$1/[redacted]",
    )
    .replace(/[A-Za-z0-9_-]{40,}/g, "[redacted]")
    .slice(0, 500);
}

function clean(detail: AlertDetail): AlertDetail {
  return Object.fromEntries(
    Object.entries(detail)
      .filter(([, value]) => value !== undefined && value !== null && value !== "")
      .map(([key, value]) => [key, typeof value === "string" ? scrub(value) : value]),
  );
}

function underHourlyCap(now: number) {
  sentAt = sentAt.filter((time) => now - time < 60 * 60_000);
  return sentAt.length < MAX_EMAILS_PER_HOUR;
}

async function email(kind: string, item: Pending, repeats: number) {
  const host = new URL(config.APP_URL).host;
  const lines = [
    `PaperSign on ${host} reported an error.`,
    "",
    `What: ${item.summary}`,
    `Kind: ${kind}`,
    `When: ${item.at.toISOString()}`,
    `Where: ${source} process on ${hostname()}`,
    ...Object.entries(item.detail).map(([key, value]) => `${key}: ${value}`),
  ];
  if (repeats > 1)
    lines.push(
      "",
      `This happened ${repeats} times since the previous alert of this kind. The details above are from the latest one.`,
    );
  lines.push(
    "",
    "Further errors of this kind are emailed at most every 15 minutes; the service log has every occurrence.",
    "Alerts never include signing links, tokens, passwords or document content.",
  );
  try {
    await sendAlertMail({
      to: config.ERROR_ALERT_EMAIL!,
      subject: `[PaperSign] ${item.summary}`.slice(0, 120),
      text: lines.join("\n"),
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        alert: "alert_email_failed",
        source,
        reason: scrub(error instanceof Error ? error.message : error),
      }),
    );
  }
}

function flush(kind: string) {
  const state = kinds.get(kind);
  if (!state) return;
  state.timer = undefined;
  if (!state.suppressed || !state.latest) return;
  const now = Date.now();
  if (!underHourlyCap(now)) {
    state.timer = setTimeout(() => flush(kind), THROTTLE_MS);
    state.timer.unref?.();
    return;
  }
  const latest = state.latest,
    repeats = state.suppressed;
  state.lastSentAt = now;
  state.suppressed = 0;
  state.latest = undefined;
  sentAt.push(now);
  void email(kind, latest, repeats);
}

/**
 * Records an error. Resolves once any alert email for it has been handed over
 * (callers in short-lived processes await it; others need not).
 */
export function reportError(
  kind: string,
  summary: string,
  detail: AlertDetail = {},
): Promise<void> {
  const item: Pending = {
    summary: scrub(summary),
    detail: clean(detail),
    at: new Date(),
  };
  console.error(
    JSON.stringify({
      level: "error",
      alert: kind,
      summary: item.summary,
      source,
      ...item.detail,
    }),
  );
  if (!config.ERROR_ALERT_EMAIL) return Promise.resolve();
  const state = kinds.get(kind) ?? { lastSentAt: 0, suppressed: 0 };
  kinds.set(kind, state);
  const now = item.at.getTime();
  if (now - state.lastSentAt >= THROTTLE_MS && !state.timer && underHourlyCap(now)) {
    state.lastSentAt = now;
    sentAt.push(now);
    return email(kind, item, 1);
  }
  state.suppressed++;
  state.latest = item;
  if (!state.timer) {
    state.timer = setTimeout(
      () => flush(kind),
      Math.max(state.lastSentAt + THROTTLE_MS - now, 1000),
    );
    state.timer.unref?.();
  }
  return Promise.resolve();
}

/** Test hook: forgets throttling state. */
export function resetAlertsForTests() {
  for (const state of kinds.values()) clearTimeout(state.timer);
  kinds.clear();
  sentAt = [];
}
