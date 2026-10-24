import { localFetch } from "./local-http.js";
import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { SIGNING_CONSENT } from "../../shared/signing-consent.js";
import { assertTestMail, waitForTestMail } from "./test-mail.js";

const proof = new Map<string, { cookie: string; reviewId: string }>();
function tokenIn(path: string) {
  return path.match(/^\/sign\/([A-Za-z0-9_-]{43})(?:[/?]|$)/)?.[1];
}
export function recipientCookies(path: string, cookie = "") {
  const token = tokenIn(path),
    saved = token ? proof.get(token) : undefined;
  return [cookie, saved?.cookie].filter(Boolean).join("; ");
}
export function recipientBody(path: string, body: unknown) {
  const token = path.match(/^\/sign\/([A-Za-z0-9_-]{43})$/)?.[1];
  return token && body && typeof body === "object"
    ? {
        consentVersion: SIGNING_CONSENT.version,
        reviewId: proof.get(token)?.reviewId ?? randomUUID(),
        ...body,
      }
    : body;
}
export async function verifyApiRecipient(
  token: string,
  email: string,
  purpose: "sign" | "record" = "sign",
) {
  const base = "http://127.0.0.1:3176";
  await assertTestMail(base);
  const requestedAt = Date.now();
  const request = async (path: string, body?: unknown, cookie = "") =>
    localFetch(`${base}/api/sign/${token}${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        Origin: base,
        "X-PaperSign": "1",
        Cookie: cookie,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  const details = await (await request("")).json();
  const prefix = purpose === "record" ? "/record" : "";
  const sent = await request(`${prefix}/verification/send`, {
    revision: details.revision,
  });
  if (sent.status !== 200)
    throw new Error(`OTP request failed: ${sent.status} ${await sent.text()}`);
  const receivedCookie = sent.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  const cookie = [proof.get(token)?.cookie, receivedCookie]
    .filter(Boolean)
    .join("; ");
  const mail = await waitForTestMail(
    email,
    "Your PaperSign verification code",
    requestedAt,
  );
  const code = mail.text.match(/code is: (\d{6})/)?.[1];
  if (!code)
    throw new Error("Local mailbox did not contain a verification code.");
  const verified = await request(
    `${prefix}/verification/confirm`,
    { revision: details.revision, code },
    cookie,
  );
  if (verified.status !== 200)
    throw new Error(
      `OTP confirmation failed: ${verified.status} ${await verified.text()}`,
    );
  if (purpose === "record") {
    proof.set(token, {
      cookie,
      reviewId: proof.get(token)?.reviewId ?? randomUUID(),
    });
    return { cookie, reviewId: proof.get(token)!.reviewId };
  }
  const pdf = await request(
    `/pdf?revision=${details.revision}`,
    undefined,
    cookie,
  );
  if (pdf.status !== 200)
    throw new Error(`Review failed: ${pdf.status} ${await pdf.text()}`);
  await pdf.arrayBuffer();
  const reviewId = pdf.headers.get("X-PaperSign-Review");
  if (!reviewId) throw new Error("Review identity was not returned.");
  proof.set(token, { cookie, reviewId });
  return { cookie, reviewId };
}
export async function verifyBrowserRecipient(page: Page, email: string) {
  await assertTestMail(new URL(page.url()).origin);
  const requestedAt = Date.now();
  const sent = page.waitForResponse(
    (response) =>
      response.url().includes("/verification/send") &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Send verification code", exact: true })
    .click();
  const response = await sent;
  if (response.status() !== 200)
    throw new Error(
      `OTP request failed: ${response.status()} ${await response.text()}`,
    );
  const mail = await waitForTestMail(
    email,
    "Your PaperSign verification code",
    requestedAt,
  );
  const code = mail.text.match(/code is: (\d{6})/)?.[1];
  if (!code)
    throw new Error("Local mailbox did not contain a verification code.");
  await page.getByLabel("Email verification code", { exact: true }).fill(code);
  await page
    .getByRole("button", { name: "Verify and open document", exact: true })
    .click();
  await page.locator(".pdf-overlay").first().waitFor({ state: "visible" });
}
