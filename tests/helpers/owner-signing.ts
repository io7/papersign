import { localFetch } from "./local-http.js";
import type { Page } from "@playwright/test";
import { SIGNING_CONSENT } from "../../shared/signing-consent.js";

const base = "http://127.0.0.1:3176";
async function ownerRequest(path: string, cookie: string, body?: unknown) {
  return localFetch(`${base}/api${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      Origin: base,
      "X-PaperSign": "1",
      Cookie: cookie,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}
async function reviewOwner(
  documentId: string,
  revision: number,
  cookie: string,
) {
  const response = await ownerRequest(
    `/documents/${documentId}/review`,
    cookie,
    { revision },
  );
  if (response.status !== 200)
    throw new Error(
      `Owner review failed: ${response.status} ${await response.text()}`,
    );
  const review = await response.json();
  const pdf = await ownerRequest(review.pdfUrl.replace(/^\/api/, ""), cookie);
  if (pdf.status !== 200 || (await pdf.arrayBuffer()).byteLength < 5)
    throw new Error("Owner review PDF was not available.");
  return review as {
    reviewId: string;
    revision: number;
    consent: { version: string };
  };
}
export async function ownerInvitationBody(
  path: string,
  cookie: string,
  body: unknown,
) {
  const documentId = path.match(/^\/documents\/([^/]+)\/invitations$/)?.[1];
  if (!documentId || !body || typeof body !== "object") return body;
  const proposed = { termsLocked: true, ...body } as Record<string, unknown>;
  const response = await ownerRequest(`/documents/${documentId}`, cookie);
  if (response.status !== 200) return proposed;
  const document = await response.json();
  if (
    document.status !== "draft" ||
    document.revision !== proposed.revision ||
    !document.placements.some(
      (placement: { kind?: string }) => placement.kind !== "text",
    )
  )
    return proposed;
  const review = await reviewOwner(documentId, document.revision, cookie);
  return {
    ...proposed,
    ownerReviewId: review.reviewId,
    ownerConsentVersion: review.consent.version,
  };
}
export async function finalizeOwnerIfNeeded(
  documentId: string,
  cookie: string,
) {
  const response = await ownerRequest(`/documents/${documentId}`, cookie);
  if (response.status !== 200)
    throw new Error("Document fixture is unavailable.");
  const document = await response.json();
  if (
    document.status !== "draft" ||
    !document.placements.some(
      (placement: { kind?: string }) => placement.kind !== "text",
    )
  )
    return document;
  const review = await reviewOwner(documentId, document.revision, cookie);
  const finalized = await ownerRequest(
    `/documents/${documentId}/finalize`,
    cookie,
    {
      revision: review.revision,
      reviewId: review.reviewId,
      consent: true,
      consentVersion: review.consent.version,
    },
  );
  if (finalized.status !== 202)
    throw new Error(
      `Owner acceptance failed: ${finalized.status} ${await finalized.text()}`,
    );
  return (await finalized.json()).document;
}
export async function acceptOwnerReview(page: Page) {
  const dialog = page.getByRole("dialog", {
    name: "Review and sign",
    exact: true,
  });
  await dialog.waitFor({ state: "visible" });
  const consent = dialog.getByLabel(SIGNING_CONSENT.text, { exact: true });
  await consent.check();
  await dialog
    .getByRole("button", { name: "Agree and sign", exact: true })
    .click();
  await dialog.waitFor({ state: "hidden" });
}
export async function declareTermsComplete(page: Page) {
  await page
    .getByLabel(
      "The agreement terms are complete. Recipient text fields are only for signing details, such as names, titles, places and dates.",
      { exact: true },
    )
    .check();
}
export async function cloneDraftForInvitations(page: Page) {
  const id = page.url().split("/").pop()!;
  const document = await (
    await page.request.get(`/api/documents/${id}`)
  ).json();
  const original = await (
    await page.request.get(`/api/documents/${id}/pdf`)
  ).body();
  await page.goto("/documents");
  await page.getByLabel("Upload PDF", { exact: true }).setInputFiles({
    name: document.name,
    mimeType: "application/pdf",
    buffer: original,
  });
  await page.waitForURL(/\/documents\/[^/]+$/);
  const newId = page.url().split("/").pop()!;
  if (newId === id)
    throw new Error(
      "The synthetic workflow requires a fresh draft after owner finalization.",
    );
  const created = await (
    await page.request.get(`/api/documents/${newId}`)
  ).json();
  const saved = await page.request.put(`/api/documents/${newId}/placements`, {
    headers: { Origin: new URL(page.url()).origin, "X-PaperSign": "1" },
    data: { revision: created.revision, placements: document.placements },
  });
  if (saved.status() !== 200)
    throw new Error(`Copying synthetic placements failed: ${saved.status()}`);
  await page.reload();
  await page.locator(".pdf-overlay").first().waitFor({ state: "visible" });
  return newId;
}
