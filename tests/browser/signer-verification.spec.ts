import { test, expect, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { samplePdf, signaturePng } from "../fixtures.js";
import { SIGNING_CONSENT } from "../../shared/signing-consent.js";

const artifacts = ".local/qa/signing-readiness";
const token = "s".repeat(43),
  reviewId = randomUUID();
async function mockRequest(
  page: Page,
  state: {
    verified: boolean;
    failedPdf: boolean;
    signed: boolean;
    deliveryAvailable: boolean;
    recordVerified?: boolean;
    record?: Record<string, unknown>;
    accepted?: Record<string, unknown>;
    authenticatorAvailable?: boolean;
    accountSession?: boolean;
    proofs?: Array<{ path: string; body: Record<string, unknown> }>;
  },
) {
  const pdf = await samplePdf();
  await page.route(`**/api/sign/${token}**`, async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (path.endsWith("/record"))
      return route.fulfill({ json: state.record ?? { state: "waiting" } });
    if (path.endsWith("/verification/send"))
      return route.fulfill({
        json: { sent: true, expiresInSeconds: 600, resendAfterSeconds: 60 },
      });
    if (path.endsWith("/verification/confirm")) {
      state.verified = true;
      return route.fulfill({ json: { verified: true } });
    }
    if (
      path.endsWith("/verification/authenticator") ||
      path.endsWith("/verification/account")
    ) {
      state.proofs?.push({
        path: path.slice(path.lastIndexOf("/") + 1),
        body: request.postDataJSON(),
      });
      state.verified = true;
      return route.fulfill({ json: { verified: true } });
    }
    if (path.endsWith("/pdf"))
      return state.failedPdf
        ? route.fulfill({
            status: 500,
            json: { message: "Synthetic viewer failure" },
          })
        : route.fulfill({
            contentType: "application/pdf",
            headers: {
              "X-PaperSign-Review": reviewId,
              "X-PaperSign-Review-SHA256": "a".repeat(64),
            },
            body: pdf,
          });
    if (request.method() === "POST") {
      state.accepted = request.postDataJSON();
      state.signed = true;
      return route.fulfill({
        json: {
          state: "signed",
          acceptanceReceiptId: randomUUID(),
          acceptanceReceiptHash: "b".repeat(64),
        },
      });
    }
    return route.fulfill({
      json: {
        name: "Synthetic invited signer",
        documentName: "Synthetic signing-readiness agreement.pdf",
        pages: [{ width: 612, height: 792, rotation: 0 }],
        field: {
          id: randomUUID(),
          pageIndex: 0,
          x: 0.1,
          y: 0.7,
          width: 0.3,
          height: 0.1,
        },
        textFields: [],
        state: state.signed ? "signed" : "pending",
        completed: state.signed,
        revision: state.signed ? 3 : 2,
        totalSigners: 1,
        signingOrder: 1,
        signingStatus: state.signed ? "signed" : "ready",
        canSign: !state.signed,
        waitingForSigners: 0,
        verification: {
          required: true,
          verified: state.verified,
          emailHint: "s•••@example.test",
          deliveryAvailable: state.deliveryAvailable,
          authenticatorAvailable: state.authenticatorAvailable ?? false,
          accountSession: state.accountSession ?? false,
        },
        recordVerification: state.signed
          ? {
              required: true,
              verified: state.recordVerified ?? false,
              emailHint: "s•••@example.test",
              deliveryAvailable: true,
            }
          : undefined,
        consent: SIGNING_CONSENT,
        canUseSavedSignature: false,
      },
    });
  });
}
async function upload(page: Page) {
  await page.getByRole("button", { name: "Upload PNG", exact: true }).click();
  await page.getByLabel("Upload signature PNG", { exact: true }).setInputFiles({
    name: "synthetic-signature.png",
    mimeType: "image/png",
    buffer: await signaturePng(),
  });
  await expect(
    page.getByRole("img", { name: "Signature preview", exact: true }),
  ).toBeVisible();
}
async function capture(page: Page, name: string) {
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    window.scrollTo(0, 0);
  });
  await page.screenshot({ path: `${artifacts}/${name}.png`, fullPage: true });
}
test.beforeAll(async () => mkdir(artifacts, { recursive: true }));

test("completed records distinguish missing historical evidence and independent timestamp status", async ({
  page,
}) => {
  const state = {
    verified: true,
    failedPdf: false,
    signed: true,
    deliveryAvailable: true,
    recordVerified: true,
    record: {
      state: "ready",
      outcome: "all-signed",
      evidenceComplete: false,
      participants: [
        { name: "Synthetic invited signer", order: 1, state: "signed" },
      ],
    } as Record<string, unknown>,
  };
  await mockRequest(page, state);
  await page.goto(`/sign/${token}`);
  await expect(
    page.getByRole("link", { name: "Download final PDF", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "This document includes signatures added before PaperSign preserved",
      { exact: false },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Download signing evidence" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Save verification receipt" }),
  ).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await capture(page, "legacy-record-mobile");
  state.record = {
    ...state.record,
    evidenceComplete: true,
    receipt: {
      format: "papersign-receipt-v1",
      documentId: randomUUID(),
      manifestSha256: "c".repeat(64),
      finalPdfSha256: "d".repeat(64),
      ledgerHead: "e".repeat(64),
    },
    timestamp: { state: "pending" },
  };
  await page.reload();
  await expect(
    page.getByRole("link", { name: "Download signing evidence" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Check timestamp status" }),
  ).toBeVisible();
  state.record.timestamp = { state: "failed" };
  await page.getByRole("button", { name: "Check timestamp status" }).click();
  await expect(
    page.getByText("The independent timestamp could not be obtained.", {
      exact: false,
    }),
  ).toBeVisible();
  state.record.timestamp = { state: "available" };
  await page.reload();
  await expect(
    page.getByText("An independent timestamp is included", { exact: false }),
  ).toBeVisible();
  await capture(page, "completed-timestamp-mobile");
});

test("mailbox verification is clear on desktop and mobile, and absent SMTP cannot bypass it", async ({
  page,
}) => {
  const state = {
    verified: false,
    failedPdf: false,
    signed: false,
    deliveryAvailable: true,
  };
  await mockRequest(page, state);
  await page.goto(`/sign/${token}`);
  await expect(
    page.getByRole("heading", { name: "Verify your email to sign" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Agree and sign" }),
  ).toHaveCount(0);
  await capture(page, "verification-desktop");
  await page
    .getByRole("button", { name: "Send verification code", exact: true })
    .click();
  await expect(
    page.getByLabel("Email verification code", { exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await capture(page, "verification-mobile");
  state.deliveryAvailable = false;
  await page.reload();
  await expect(
    page.getByText("Email verification is unavailable.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Send verification code", exact: true }),
  ).toHaveCount(0);
});

test("a viewer failure blocks consent; a loaded revision supplies the retained review and versioned acceptance", async ({
  page,
}) => {
  const state = {
    verified: true,
    failedPdf: true,
    signed: false,
    deliveryAvailable: true,
    accepted: undefined as Record<string, unknown> | undefined,
  };
  await mockRequest(page, state);
  await page.goto(`/sign/${token}`);
  await expect(
    page.getByText("The PDF could not be opened.", { exact: false }),
  ).toBeVisible();
  await upload(page);
  await expect(page.getByLabel(SIGNING_CONSENT.text)).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Agree and sign", exact: true }),
  ).toBeDisabled();
  await capture(page, "failed-viewer-desktop");
  state.failedPdf = false;
  await page.reload();
  await expect(page.locator(".pdf-overlay")).toBeVisible();
  await upload(page);
  await page.getByLabel(SIGNING_CONSENT.text).check();
  await expect(
    page.getByRole("button", { name: "Agree and sign", exact: true }),
  ).toBeEnabled();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await capture(page, "review-mobile");
  await page
    .getByRole("button", { name: "Agree and sign", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your signature is in place." }),
  ).toBeVisible();
  expect(state.accepted?.reviewId).toBe(reviewId);
  expect(state.accepted?.consentVersion).toBe(SIGNING_CONSENT.version);
  await expect(
    page.getByRole("button", { name: "Save my acceptance receipt" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Your signing record" }),
  ).toBeVisible();
  await capture(page, "completed-mobile");
});

test("the wait after sending a signing code does not hold back the signing-record code", async ({
  page,
}) => {
  const state = {
    verified: false,
    failedPdf: false,
    signed: false,
    deliveryAvailable: true,
  };
  await mockRequest(page, state);
  await page.goto(`/sign/${token}`);
  await page
    .getByRole("button", { name: "Send verification code", exact: true })
    .click();
  await page
    .getByLabel("Email verification code", { exact: true })
    .fill("123456");
  await page
    .getByRole("button", { name: "Verify and open document", exact: true })
    .click();
  await expect(page.locator(".pdf-overlay")).toBeVisible();
  await upload(page);
  await page.getByLabel(SIGNING_CONSENT.text).check();
  await page
    .getByRole("button", { name: "Agree and sign", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your signing record" }),
  ).toBeVisible();
  // The server limits signing codes and record codes separately.
  await expect(
    page.getByRole("button", { name: "Send verification code", exact: true }),
  ).toBeEnabled();
});

test("an account holder verifies with the authenticator code, with the email code as fallback", async ({
  page,
}) => {
  const state = {
    verified: false,
    failedPdf: false,
    signed: false,
    deliveryAvailable: true,
    authenticatorAvailable: true,
    proofs: [] as Array<{ path: string; body: Record<string, unknown> }>,
  };
  await mockRequest(page, state);
  await page.goto(`/sign/${token}`);
  await expect(
    page.getByRole("heading", { name: "Confirm it's you to sign" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Send verification code", exact: true }),
  ).toHaveCount(0);
  await capture(page, "authenticator-desktop");
  await page
    .getByRole("button", { name: "Email me a code instead", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Verify your email to sign" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Send verification code", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", {
      name: "Use my authenticator app instead",
      exact: true,
    })
    .click();
  const field = page.getByLabel("Authenticator code", { exact: true });
  await field.fill("12345");
  await expect(
    page.getByRole("button", { name: "Verify and open document", exact: true }),
  ).toBeDisabled();
  await field.fill("123456");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await capture(page, "authenticator-mobile");
  await page
    .getByRole("button", { name: "Verify and open document", exact: true })
    .click();
  await expect(page.locator(".pdf-overlay")).toBeVisible();
  expect(state.proofs).toEqual([
    { path: "authenticator", body: { revision: 2, code: "123456" } },
  ]);
});

test("a signed-in account confirmed with its authenticator continues in one step", async ({
  page,
}) => {
  const state = {
    verified: false,
    failedPdf: false,
    signed: false,
    deliveryAvailable: true,
    authenticatorAvailable: true,
    accountSession: true,
    proofs: [] as Array<{ path: string; body: Record<string, unknown> }>,
  };
  await mockRequest(page, state);
  await page.goto(`/sign/${token}`);
  await expect(
    page.getByRole("heading", { name: "Confirm it's you to sign" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Use an email code instead" }),
  ).toBeVisible();
  await expect(
    page.getByText("Never share your code", { exact: false }),
  ).toHaveCount(0);
  await capture(page, "account-session-desktop");
  await page
    .getByRole("button", { name: "Continue to the document", exact: true })
    .click();
  await expect(page.locator(".pdf-overlay")).toBeVisible();
  expect(state.proofs).toEqual([{ path: "account", body: { revision: 2 } }]);
});
