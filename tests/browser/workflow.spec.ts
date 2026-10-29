import { verifyBrowserRecipient } from "../helpers/signer-verification.js";
import { SIGNING_CONSENT } from "../../shared/signing-consent.js";
import {
  acceptOwnerReview,
  declareTermsComplete,
  cloneDraftForInvitations,
} from "../helpers/owner-signing.js";
import { copySigningLink } from "../helpers/signing-links.js";
import { verifyFixtureEmail } from "../helpers/account-security.js";
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, appendFile } from "node:fs/promises";
import { samplePdf, signaturePng, whiteSignaturePng } from "../fixtures";
async function register(page: Page, label: string) {
  const email = `${label.replace(/[^a-z]/gi, "").toLowerCase()}-${randomUUID()}@example.invalid`,
    password = `Private-test-${randomUUID()}`;
  await page.goto("/register");
  await expect(page.getByLabel("Your name", { exact: true })).toBeVisible();
  await page.getByLabel("Your name", { exact: true }).fill(label);
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  const submit = async () => {
    const response = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/auth/sign-up/email") &&
        response.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Create account", exact: true })
      .click();
    return response;
  };
  let registration = await submit();
  if (registration.status() === 429) {
    // Multiple browser scenarios share one real source IP. Respect the auth
    // provider's cooldown instead of weakening or bypassing its rate limit.
    const delay = Number(
      registration.headers()["x-retry-after"] ??
        registration.headers()["retry-after"],
    );
    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThanOrEqual(60);
    await page.waitForTimeout((delay + 1) * 1000);
    registration = await submit();
  }
  expect(registration.status()).toBe(200);
  await verifyFixtureEmail((await registration.json()).user.id, email);
  await page.goto("/login");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  const submitLogin = async () => {
    const response = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/auth/sign-in/email") &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    return response;
  };
  let login = await submitLogin();
  if (login.status() === 429) {
    const delay = Number(
      login.headers()["x-retry-after"] ?? login.headers()["retry-after"],
    );
    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThanOrEqual(60);
    await page.waitForTimeout((delay + 1) * 1000);
    login = await submitLogin();
  }
  expect(login.status()).toBe(200);
  await expect(page).toHaveURL(/\/documents$/);
  if (process.env.TEST_ACCOUNT_LOG) {
    const session = await page.evaluate(async () =>
      (await fetch("/api/auth/get-session")).json(),
    );
    await appendFile(
      process.env.TEST_ACCOUNT_LOG,
      JSON.stringify({ id: session.user.id, email: session.user.email }) + "\n",
      { mode: 0o600 },
    );
    if (process.env.TEST_CLIENT_IP_PROBE === "true")
      expect(session.session.ipAddress).not.toBe("198.51.100.19");
  }
  return { email, password };
}
async function draw(page: Page) {
  const canvas = page.getByRole("img", {
    name: "Draw your signature",
    exact: true,
  });
  await expect(canvas).toBeVisible();
  const bounds = (await canvas.boundingBox())!;
  await page.mouse.move(bounds.x + 30, bounds.y + 130);
  await page.mouse.down();
  for (const [x, y] of [
    [45, 110],
    [65, 40],
    [80, 45],
    [58, 145],
    [95, 105],
    [125, 80],
    [140, 130],
    [165, 85],
    [190, 115],
    [230, 90],
  ])
    await page.mouse.move(bounds.x + x, bounds.y + y, { steps: 3 });
  await page.mouse.up();
}
async function settleOwnerCapture(page: Page) {
  // Capture from the page origin so fixed-position controls do not appear in
  // the middle of Playwright's full-page image after a scrolled form action.
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(100);
}
async function ownerViewport(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await settleOwnerCapture(page);
}
async function captureOwner(page: Page, path: string, fullPage = true) {
  await settleOwnerCapture(page);
  // Full-page capture temporarily changes dynamic viewport units. Keep the PDF
  // viewport at its actual visible height while capturing the surrounding page.
  const stageHeight = fullPage
    ? await page
        .locator(".pdf-stage")
        .evaluateAll((elements) => elements[0]?.clientHeight)
    : undefined;
  await page.screenshot({
    path,
    fullPage,
    style: stageHeight
      ? `.pdf-stage { max-height: ${stageHeight}px !important; }`
      : undefined,
  });
}
async function expectCleanPreview(page: Page) {
  const preview = page.getByRole("img", {
    name: "Signature preview",
    exact: true,
  });
  await expect(preview).toBeVisible();
  const proof = await preview.evaluate(async (element) => {
    const image = element as HTMLImageElement;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let opaqueWhitePixels = 0,
      blackPixels = 0,
      bluePixels = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (!pixels[i + 3]) continue;
      if (pixels[i] >= 245 && pixels[i + 1] >= 245 && pixels[i + 2] >= 245)
        opaqueWhitePixels++;
      if (pixels[i] < 10 && pixels[i + 1] < 10 && pixels[i + 2] < 10)
        blackPixels++;
      if (
        pixels[i] < 10 &&
        pixels[i + 1] >= 60 &&
        pixels[i + 1] <= 70 &&
        pixels[i + 2] > 180
      )
        bluePixels++;
    }
    const middle =
      (Math.floor(canvas.height / 2) * canvas.width +
        Math.floor(canvas.width / 2)) *
      4;
    return {
      centerAlpha: pixels[middle + 3],
      opaqueWhitePixels,
      blackPixels,
      bluePixels,
    };
  });
  expect(proof.centerAlpha).toBe(0);
  expect(proof.opaqueWhitePixels).toBe(0);
  expect(proof.blackPixels).toBeGreaterThan(200);
  expect(proof.bluePixels).toBeGreaterThan(200);
}
test("register, draw, save, reuse after login, place, download, and invite a guest", async ({
  page,
  browser,
}) => {
  await mkdir(".impeccable/review", { recursive: true });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const account = await register(page, "Alex Morgan");
  await page.getByRole("link", { name: "My signatures" }).click();
  await page
    .getByRole("button", { name: "Draw signature", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Save signature", exact: true }),
  ).toBeDisabled();
  await draw(page);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Save signature", exact: true }),
  ).toBeDisabled();
  await draw(page);
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Save signature", exact: true }),
  ).toBeDisabled();
  await draw(page);
  await page
    .getByLabel("Signature name", { exact: true })
    .fill("Everyday signature");
  await page
    .getByRole("button", { name: "Save signature", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Everyday signature" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Upload PNG", exact: true })
    .first()
    .click();
  await page
    .getByLabel("Signature name", { exact: true })
    .fill("Uploaded signature");
  await page.getByLabel("Upload signature PNG").setInputFiles({
    name: "signature.png",
    mimeType: "image/png",
    buffer: await signaturePng(),
  });
  await page
    .getByRole("button", { name: "Save signature", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Uploaded signature" }),
  ).toBeVisible();
  await page.screenshot({
    path: ".impeccable/review/signatures-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByLabel("Email address").fill(account.email);
  await page.getByLabel("Password", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/documents$/);
  await page.getByLabel("Upload PDF", { exact: true }).setInputFiles({
    name: "Consulting agreement.pdf",
    mimeType: "application/pdf",
    buffer: await samplePdf(false),
  });
  await expect(
    page.getByRole("heading", { name: "Consulting agreement.pdf" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Add to this page", exact: true })
    .click();
  await expect(page.locator(".pdf-overlay")).toBeVisible();
  const placement = page.locator(".placement.editable");
  await expect(placement).toBeVisible();
  await placement.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Alt+ArrowRight");
  await expect(
    page.getByRole("status").filter({ hasText: "All page edits saved" }),
  ).toBeVisible();
  await page.screenshot({
    path: ".impeccable/review/editor-desktop.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Advanced download", exact: true })
    .click();
  const advanced = page.getByRole("dialog", {
    name: "Advanced download",
    exact: true,
  });
  await advanced.getByLabel("Rasterize the download").check();
  await advanced
    .getByRole("button", { name: "Prepare download", exact: true })
    .click();
  await acceptOwnerReview(page);
  const downloadLink = page.getByRole("link", { name: "Download signed PDF" });
  await expect(downloadLink).toBeVisible({ timeout: 30000 });
  const downloadPromise = page.waitForEvent("download");
  await downloadLink.click();
  const download = await downloadPromise;
  await download.saveAs(".local/qa/browser-signed.pdf");
  expect(
    (await readFile(".local/qa/browser-signed.pdf")).subarray(0, 5).toString(),
  ).toBe("%PDF-");
  await cloneDraftForInvitations(page);
  await page
    .getByRole("button", { name: "Invite to sign", exact: true })
    .click();
  await page.getByLabel("Recipient name", { exact: true }).fill("Jordan Lee");
  await page
    .getByLabel("Recipient email", { exact: true })
    .fill("jordan@example.invalid");
  await page
    .getByRole("button", { name: "Add signing field", exact: true })
    .click();
  await declareTermsComplete(page);
  await page
    .getByRole("button", { name: "Create signing links", exact: true })
    .click();
  await acceptOwnerReview(page);
  const link = await copySigningLink(page, "Jordan Lee");
  const guest = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const signer = await guest.newPage();
  await signer.goto(link);
  await verifyBrowserRecipient(signer, "jordan@example.invalid");
  await expect(
    signer.getByRole("heading", { name: "Review and sign" }),
  ).toBeVisible();
  await draw(signer);
  await expect(signer.locator(".pdf-overlay")).toBeVisible();
  await signer.screenshot({
    path: ".impeccable/review/guest-desktop.png",
    fullPage: true,
  });
  await signer.getByLabel(SIGNING_CONSENT.text).check();
  await signer
    .getByRole("button", { name: "Agree and sign", exact: true })
    .click();
  await expect(
    signer.getByRole("heading", { name: "Your signature is in place." }),
  ).toBeVisible();
  await guest.close();
  await page
    .getByRole("button", { name: "Refresh status", exact: true })
    .click();
  await expect(
    page.getByText("Signing completed", { exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
test("build and reorder a signer list, share links, and sign one after another", async ({
  page,
  browser,
}) => {
  await mkdir(".impeccable/review", { recursive: true });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await register(page, "Serial signing owner");
  await page.getByLabel("Upload PDF", { exact: true }).setInputFiles({
    name: "Service agreement.pdf",
    mimeType: "application/pdf",
    buffer: await samplePdf(false),
  });
  await expect(
    page.getByRole("heading", { name: "Service agreement.pdf" }),
  ).toBeVisible();
  await expect(page.locator(".pdf-overlay")).toBeVisible();
  await page
    .getByRole("button", { name: "Invite to sign", exact: true })
    .click();
  const names = ["Maya Patel", "Jordan Lee", "Sam Rivera"];
  for (const [index, name] of names.entries()) {
    await page.getByLabel("Recipient name", { exact: true }).fill(name);
    await page
      .getByLabel("Recipient email", { exact: true })
      .fill(`serial-${index}@example.invalid`);
    await page
      .getByRole("button", { name: "Add signing field", exact: true })
      .click();
  }
  const ordered = page.getByRole("list", { name: "Signer order", exact: true });
  await expect(ordered.getByRole("listitem")).toHaveCount(3);
  await page
    .getByRole("button", { name: "Move Jordan Lee up", exact: true })
    .click();
  await expect(ordered.getByRole("listitem").first()).toContainText(
    "Jordan Lee",
  );
  // Exercise the ordering controls at the narrow width as well as desktop.
  await ownerViewport(page, 390, 844);
  await page
    .getByRole("button", { name: "Remove Sam Rivera", exact: true })
    .click();
  await expect(ordered.getByRole("listitem")).toHaveCount(2);
  await page
    .getByRole("button", { name: "Move Maya Patel up", exact: true })
    .click();
  await expect(ordered.getByRole("listitem").first()).toContainText(
    "Maya Patel",
  );
  await page
    .getByRole("button", { name: "Move Maya Patel down", exact: true })
    .click();
  await expect(ordered.getByRole("listitem").first()).toContainText(
    "Jordan Lee",
  );
  await expect(
    page.getByRole("button", { name: "Move Jordan Lee up", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Move Maya Patel down", exact: true }),
  ).toBeDisabled();
  await page
    .getByLabel("Recipient name", { exact: true })
    .fill("Unfinished signer");
  await expect(
    page.getByRole("button", { name: "Create signing links", exact: true }),
  ).toBeDisabled();
  await page.getByLabel("Recipient name", { exact: true }).clear();
  await ownerViewport(page, 1440, 1000);
  await captureOwner(page, ".impeccable/review/serial-draft-desktop.png");
  await ownerViewport(page, 390, 844);
  await captureOwner(page, ".impeccable/review/serial-draft-mobile.png");
  await ownerViewport(page, 1440, 1000);
  await declareTermsComplete(page);
  await page
    .getByRole("button", { name: "Create signing links", exact: true })
    .click();
  const requests = page.getByRole("list", {
    name: "Signing requests",
    exact: true,
  });
  await expect(requests.getByRole("listitem")).toHaveCount(2);
  await expect(requests.getByRole("listitem").first()).toContainText(
    "Jordan Lee",
  );
  await expect(requests.getByRole("listitem").first()).toContainText(
    "Ready to sign",
  );
  await expect(requests.getByRole("listitem").nth(1)).toContainText(
    "Waiting for Jordan Lee",
  );
  // The link box only appears if copying fails.
  await expect(requests.getByRole("textbox")).toHaveCount(0);
  await ownerViewport(page, 390, 844);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await captureOwner(page, ".impeccable/review/serial-owner-mobile.png");
  await ownerViewport(page, 1440, 1000);
  await captureOwner(page, ".impeccable/review/serial-owner-desktop.png");
  const firstUrl = await copySigningLink(page, "Jordan Lee");
  const secondUrl = await copySigningLink(page, "Maya Patel");
  expect(firstUrl).not.toBe(secondUrl);
  const firstContext = await browser.newContext({
    viewport: { width: 1280, height: 1000 },
  });
  const secondContext = await browser.newContext({
    viewport: { width: 1280, height: 1000 },
  });
  const first = await firstContext.newPage(),
    second = await secondContext.newPage();
  first.on("pageerror", (error) => errors.push(error.message));
  second.on("pageerror", (error) => errors.push(error.message));
  await second.goto(secondUrl);
  await expect(
    second.getByRole("heading", { name: "Waiting for your turn", exact: true }),
  ).toBeVisible();
  await expect(
    second.getByText("Signer 2 of 2", { exact: true }),
  ).toBeVisible();
  await expect(
    second.getByRole("button", { name: "Agree and sign", exact: true }),
  ).toHaveCount(0);
  await expect(
    second.getByRole("link", { name: "Open PDF in a new tab", exact: true }),
  ).toHaveCount(0);
  await second
    .getByRole("button", { name: "Check again", exact: true })
    .click();
  await expect(
    second.getByRole("heading", { name: "Waiting for your turn", exact: true }),
  ).toBeVisible();
  await captureOwner(second, ".impeccable/review/serial-waiting-desktop.png");
  await first.goto(firstUrl);
  await verifyBrowserRecipient(first, "serial-1@example.invalid");
  await expect(
    first.getByRole("heading", { name: "Review and sign", exact: true }),
  ).toBeVisible();
  await draw(first);
  await first.getByLabel(SIGNING_CONSENT.text).check();
  await first
    .getByRole("button", { name: "Agree and sign", exact: true })
    .click();
  await expect(
    first.getByRole("heading", {
      name: "Your signature is in place.",
      exact: true,
    }),
  ).toBeVisible();
  await second
    .getByRole("button", { name: "Check again", exact: true })
    .click();
  await verifyBrowserRecipient(second, "serial-0@example.invalid");
  await expect(
    second.getByRole("heading", { name: "Review and sign", exact: true }),
  ).toBeVisible();
  const pdfLink = second.getByRole("link", {
    name: "Open PDF in a new tab",
    exact: true,
  });
  await expect(pdfLink).toHaveAttribute("href", /\/pdf\?revision=\d+$/);
  await expect(second.locator(".pdf-overlay")).toBeVisible();
  await captureOwner(second, ".impeccable/review/serial-ready-desktop.png");
  await draw(second);
  await second.getByLabel(SIGNING_CONSENT.text).check();
  await second
    .getByRole("button", { name: "Agree and sign", exact: true })
    .click();
  await expect(
    second.getByRole("heading", {
      name: "Your signature is in place.",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Refresh status", exact: true })
    .click();
  await expect(
    page.getByText("Signing completed", { exact: true }),
  ).toBeVisible();
  await expect(requests.getByText(/^Signed /)).toHaveCount(2);
  // Signed steps have nothing left to do.
  await expect(requests.getByRole("button")).toHaveCount(0);
  expect(errors).toEqual([]);
  await firstContext.close();
  await secondContext.close();
});
test("clean uploaded signatures, edit with Delete, scroll the entire PDF, and choose advanced downloads", async ({
  page,
  browser,
}) => {
  await mkdir(".impeccable/review", { recursive: true });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await register(page, "PDF workflow owner");
  await page.getByRole("link", { name: "My signatures", exact: true }).click();
  await page
    .getByRole("button", { name: "Upload PNG", exact: true })
    .first()
    .click();
  await page
    .getByLabel("Signature name", { exact: true })
    .fill("Clean uploaded signature");
  await page.getByLabel("Upload signature PNG", { exact: true }).setInputFiles({
    name: "signature-on-white.png",
    mimeType: "image/png",
    buffer: await whiteSignaturePng(),
  });
  await expectCleanPreview(page);
  await page
    .getByRole("button", { name: "Save signature", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Clean uploaded signature",
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Documents", exact: true }).click();
  const pdfRequests: string[] = [],
    exportModes: boolean[] = [];
  page.on("request", (request) => {
    if (/\/api\/documents\/[^/]+\/pdf(?:\?|$)/.test(request.url()))
      pdfRequests.push(request.url());
    if (
      request.method() === "POST" &&
      /\/api\/documents\/[^/]+\/exports$/.test(request.url())
    )
      exportModes.push(request.postDataJSON().rasterize);
  });
  await page.getByLabel("Upload PDF", { exact: true }).setInputFiles({
    name: "Multi-page review.pdf",
    mimeType: "application/pdf",
    buffer: await samplePdf(true, 2),
  });
  await expect(
    page.getByRole("heading", { name: "Multi-page review.pdf", exact: true }),
  ).toBeVisible();
  const viewer = page.getByRole("region", {
    name: "Scrollable PDF document",
    exact: true,
  });
  const pages = viewer.locator(".pdf-page-container");
  await expect(pages).toHaveCount(8);
  const pageAt = (index: number) =>
    viewer.locator(`.pdf-page-container[data-page-index="${index}"]`);
  await expect(pageAt(0).locator(".pdf-overlay")).toBeVisible();
  await expect(page.getByLabel("Rasterize the download")).not.toBeVisible();
  await page
    .getByRole("button", { name: "Add to this page", exact: true })
    .click();
  await expect(pageAt(0).locator(".placement.editable")).toHaveCount(1);
  await pageAt(0).locator(".placement.editable").focus();
  await page.keyboard.press("Delete");
  await expect(pageAt(0).locator(".placement.editable")).toHaveCount(0);
  expect(
    await page.evaluate(
      async () => (await (await fetch("/api/signatures")).json()).length,
    ),
  ).toBe(1);
  await page
    .getByRole("button", { name: "Add to this page", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Invite to sign", exact: true })
    .click();
  const recipientName = page.getByLabel("Recipient name", { exact: true });
  const recipientEmail = page.getByLabel("Recipient email", { exact: true });
  await recipientName.fill("Delete guard");
  await recipientName.press("Home");
  await recipientName.press("Delete");
  await expect(recipientName).toHaveValue("elete guard");
  await expect(pageAt(0).locator(".placement.editable")).toHaveCount(1);
  await recipientEmail.fill("delete@example.invalid");
  await recipientEmail.press("Home");
  await recipientEmail.press("Delete");
  await expect(recipientEmail).toHaveValue("elete@example.invalid");
  await expect(pageAt(0).locator(".placement.editable")).toHaveCount(1);
  await recipientName.clear();
  await recipientEmail.clear();
  // A small temporary editable fixture exercises the global keyboard guard;
  // it is removed before any screenshots and never changes app state.
  await page.evaluate(() => {
    const editable = document.createElement("div");
    editable.contentEditable = "true";
    editable.dataset.qaEditable = "true";
    editable.textContent = "safe text";
    document.body.append(editable);
  });
  const editable = page.locator('[data-qa-editable="true"]');
  await editable.focus();
  await editable.press("Home");
  await editable.press("Delete");
  await expect(editable).toHaveText("afe text");
  await expect(pageAt(0).locator(".placement.editable")).toHaveCount(1);
  await editable.evaluate((element) => element.remove());
  await page.getByRole("button", { name: "My signature", exact: true }).click();
  await viewer.evaluate((element) =>
    element.scrollTo({ top: element.scrollHeight }),
  );
  await expect(page.getByLabel("PDF page", { exact: true })).toHaveValue("7");
  await expect(
    pageAt(7).getByLabel("PDF page 8 preview", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Add to this page", exact: true })
    .click();
  await expect(pageAt(7).locator(".placement.editable")).toHaveCount(1);
  await expect
    .poll(() => viewer.locator("canvas").count())
    .toBeLessThanOrEqual(6);
  await page
    .getByLabel("PDF page", { exact: true })
    .selectOption({ value: "0" });
  await expect(page.getByLabel("PDF page", { exact: true })).toHaveValue("0");
  await expect(
    pageAt(0).getByLabel("PDF page 1 preview", { exact: true }),
  ).toBeVisible();
  await expect(pageAt(0).locator(".placement.editable")).toHaveCount(1);
  await page
    .getByLabel("PDF page", { exact: true })
    .selectOption({ value: "7" });
  await expect(page.getByLabel("PDF page", { exact: true })).toHaveValue("7");
  await expect(
    page.getByRole("status").filter({ hasText: "All page edits saved" }),
  ).toBeVisible();
  let documentId = page.url().split("/").pop()!;
  const placements = await page.evaluate(
    async (id) =>
      (await (await fetch(`/api/documents/${id}`)).json()).placements,
    documentId,
  );
  expect(
    placements.map((placement: any) => placement.pageIndex).sort(),
  ).toEqual([0, 7]);
  expect(pdfRequests).toHaveLength(1);
  await captureOwner(
    page,
    ".impeccable/review/continuous-pdf-desktop.png",
    false,
  );
  await ownerViewport(page, 390, 844);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await captureOwner(
    page,
    ".impeccable/review/continuous-pdf-mobile.png",
    false,
  );
  await ownerViewport(page, 1440, 1000);
  const download = async (path: string) => {
    const link = page.getByRole("link", {
      name: "Download signed PDF",
      exact: true,
    });
    await expect(link).toBeVisible({ timeout: 30000 });
    const pending = page.waitForEvent("download");
    await link.click();
    await (await pending).saveAs(path);
    return JSON.parse(
      execFileSync(process.execPath, ["tests/check_download_pdf.mjs", path], {
        encoding: "utf8",
      }),
    );
  };
  await page
    .getByRole("button", { name: "Review and sign", exact: true })
    .click();
  await mkdir(".local/qa/readiness", { recursive: true });
  const ownerReview = page.getByRole("dialog", {
    name: "Review and sign",
    exact: true,
  });
  await expect(ownerReview.getByLabel(SIGNING_CONSENT.text)).toBeEnabled();
  await page.screenshot({
    path: ".local/qa/readiness/owner-review-desktop.png",
  });
  await ownerViewport(page, 390, 844);
  await page.screenshot({
    path: ".local/qa/readiness/owner-review-mobile.png",
  });
  await ownerViewport(page, 1440, 1000);
  await acceptOwnerReview(page);
  const normalProof = await download(".local/qa/browser-default-normal.pdf");
  expect(normalProof.pages).toBe(8);
  expect(normalProof.textLength).toBeGreaterThan(0);
  expect(exportModes).toEqual([false]);
  await expect(
    page.getByRole("link", { name: "Download completed PDF", exact: true }),
  ).toBeVisible();
  await captureOwner(page, ".local/qa/readiness/owner-completed-desktop.png");
  await ownerViewport(page, 390, 844);
  await captureOwner(page, ".local/qa/readiness/owner-completed-mobile.png");
  await ownerViewport(page, 1440, 1000);
  const advancedButton = page.getByRole("button", {
    name: "Advanced download",
    exact: true,
  });
  await advancedButton.click();
  const advanced = page.getByRole("dialog", {
    name: "Advanced download",
    exact: true,
  });
  await expect(advanced).toBeVisible();
  await expect(
    advanced.getByLabel("Rasterize the download", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Delete");
  expect(
    await page.evaluate(
      async (id) =>
        (await (await fetch(`/api/documents/${id}`)).json()).placements.length,
      documentId,
    ),
  ).toBe(2);
  await expect(pageAt(7).locator(".placement")).toHaveCount(1);
  await expect(viewer.locator(".placement.editable")).toHaveCount(0);
  const dialogFocus = [];
  for (let index = 0; index < 7; index++) {
    await page.keyboard.press("Tab");
    const focus = await advanced.evaluate((element) => ({
      modal: element.matches(":modal"),
      inside: element.contains(document.activeElement),
      tag: document.activeElement?.tagName,
      hasFocus: document.hasFocus(),
      browserChrome:
        !document.hasFocus() && document.activeElement === document.body,
    }));
    dialogFocus.push(focus);
    expect(focus.modal).toBe(true);
    // Native dialogs allow Tab to visit browser chrome, but the underlying app
    // must remain inert and no background control may receive focus.
    expect(focus.inside || focus.browserChrome).toBe(true);
  }
  await test.info().attach("advanced-dialog-focus-sequence", {
    body: JSON.stringify(dialogFocus, null, 2),
    contentType: "application/json",
  });
  await page.keyboard.press("Escape");
  await expect(advanced).not.toBeVisible();
  await expect(advancedButton).toBeFocused();
  await expect(page.getByLabel("Rasterize the download")).not.toBeVisible();
  await advancedButton.click();
  await captureOwner(
    page,
    ".impeccable/review/advanced-download-desktop.png",
    false,
  );
  await ownerViewport(page, 390, 844);
  await captureOwner(
    page,
    ".impeccable/review/advanced-download-mobile.png",
    false,
  );
  await advanced.getByLabel("Rasterize the download", { exact: true }).check();
  await advanced
    .getByRole("button", { name: "Prepare download", exact: true })
    .click();
  const rasterProof = await download(
    ".local/qa/browser-advanced-rasterized.pdf",
  );
  expect(rasterProof).toEqual({ pages: 8, textLength: 0 });
  expect(exportModes).toEqual([false, true]);
  await ownerViewport(page, 1440, 1000);
  documentId = await cloneDraftForInvitations(page);
  await page
    .getByLabel("PDF page", { exact: true })
    .selectOption({ value: "7" });
  await page
    .getByRole("button", { name: "Invite to sign", exact: true })
    .click();
  await recipientName.fill("Temporary signer");
  await recipientEmail.fill("temporary-guest@example.invalid");
  await page
    .getByRole("button", { name: "Add signing field", exact: true })
    .click();
  await expect(
    page
      .getByRole("list", { name: "Signer order", exact: true })
      .getByRole("listitem"),
  ).toHaveCount(1);
  await viewer.focus();
  await page.keyboard.press("Delete");
  const temporarySignerField = pageAt(7).locator(".placement.recipient");
  await expect(temporarySignerField).not.toHaveClass(/active/);
  await expect(
    page
      .getByRole("list", { name: "Signer order", exact: true })
      .getByRole("listitem"),
  ).toHaveCount(1);
  await temporarySignerField.click();
  await temporarySignerField.press("Delete");
  await expect(
    page.getByRole("list", { name: "Signer order", exact: true }),
  ).toHaveCount(0);
  await recipientName.fill("Taylor Reed");
  await recipientEmail.fill("scrolling-guest@example.invalid");
  await page
    .getByRole("button", { name: "Add signing field", exact: true })
    .click();
  await declareTermsComplete(page);
  await page
    .getByRole("button", { name: "Create signing links", exact: true })
    .click();
  await acceptOwnerReview(page);
  const guestUrl = await copySigningLink(page, "Taylor Reed");
  const lockedPlacements = await viewer.locator(".placement").count();
  expect(lockedPlacements).toBeGreaterThan(0);
  await viewer.focus();
  await page.keyboard.press("Delete");
  await expect(viewer.locator(".placement")).toHaveCount(lockedPlacements);
  expect(
    await page.evaluate(
      async (id) =>
        (await (await fetch(`/api/documents/${id}`)).json()).placements.length,
      documentId,
    ),
  ).toBe(2);
  const guestContext = await browser.newContext({
    viewport: { width: 1280, height: 1000 },
  });
  const guest = await guestContext.newPage();
  guest.on("pageerror", (error) => errors.push(error.message));
  const guestPdfRequests: string[] = [];
  guest.on("request", (request) => {
    if (/\/api\/sign\/[^/]+\/pdf\?revision=/.test(request.url()))
      guestPdfRequests.push(request.url());
  });
  await guest.goto(guestUrl);
  await verifyBrowserRecipient(guest, "scrolling-guest@example.invalid");
  await expect(
    guest.getByRole("heading", { name: "Review and sign", exact: true }),
  ).toBeVisible();
  const guestViewer = guest.getByRole("region", {
    name: "Scrollable PDF document",
    exact: true,
  });
  await expect(guestViewer.locator(".pdf-page-container")).toHaveCount(8);
  await guest
    .getByLabel("PDF page", { exact: true })
    .selectOption({ value: "0" });
  await expect(guest.getByLabel("PDF page", { exact: true })).toHaveValue("0");
  await guest
    .getByRole("button", { name: "Go to signature", exact: true })
    .click();
  await expect(guest.getByLabel("PDF page", { exact: true })).toHaveValue("7");
  await expect(
    guestViewer.locator(
      '.pdf-page-container[data-page-index="7"] .pdf-overlay',
    ),
  ).toBeVisible();
  await expect
    .poll(() => guestViewer.locator("canvas").count())
    .toBeLessThanOrEqual(6);
  expect(guestPdfRequests).toHaveLength(1);
  await captureOwner(
    guest,
    ".impeccable/review/continuous-guest-desktop.png",
    false,
  );
  await guest.getByRole("button", { name: "Upload PNG", exact: true }).click();
  await guest
    .getByLabel("Upload signature PNG", { exact: true })
    .setInputFiles({
      name: "guest-on-white.png",
      mimeType: "image/png",
      buffer: await whiteSignaturePng(),
    });
  await expectCleanPreview(guest);
  await guest.getByLabel(SIGNING_CONSENT.text).check();
  await guest
    .getByRole("button", { name: "Agree and sign", exact: true })
    .click();
  await expect(
    guest.getByRole("heading", {
      name: "Your signature is in place.",
      exact: true,
    }),
  ).toBeVisible();
  expect(errors).toEqual([]);
  await guestContext.close();
  await page
    .getByRole("button", { name: "Refresh status", exact: true })
    .click();
  const ownerDocumentUrl = page.url();
  const ownerDocumentName = (await page
    .getByRole("heading", { level: 1 })
    .textContent())!;
  page.once("dialog", (dialog) => dialog.accept(ownerDocumentName));
  await page
    .getByRole("button", { name: "Request document deletion", exact: true })
    .click();
  await expect(page).toHaveURL(/\/privacy$/);
  const recovery = page
    .locator(".privacy-requests li")
    .filter({ hasText: ownerDocumentName });
  await expect(recovery).toContainText("In recovery window");
  await page.screenshot({
    path: ".local/qa/readiness/owner-deletion-recovery.png",
    fullPage: true,
  });
  await recovery
    .getByRole("button", { name: "Withdraw request", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "document remains available",
  );
  await page.goto(ownerDocumentUrl);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    ownerDocumentName,
  );
  expect(errors).toEqual([]);
});
test("draw with touch, resize, save, and reuse on a mobile screen", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  await register(page, "Mobile user");
  await page.getByRole("link", { name: "My signatures" }).click();
  await page
    .getByRole("button", { name: "Draw signature", exact: true })
    .click();
  await page
    .getByLabel("Signature name", { exact: true })
    .fill("Touch signature");
  const canvas = page.getByRole("img", {
    name: "Draw your signature",
    exact: true,
  });
  await canvas.scrollIntoViewIfNeeded();
  const bounds = (await canvas.boundingBox())!;
  const input = await context.newCDPSession(page);
  await input.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: bounds.x + 25, y: bounds.y + 130 }],
  });
  for (const [x, y] of [
    [45, 75],
    [65, 45],
    [55, 150],
    [90, 105],
    [125, 70],
    [140, 120],
    [190, 80],
    [235, 110],
  ]) {
    // SignaturePad samples pointer events; model a real finger moving over time.
    await page.waitForTimeout(20);
    await input.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: bounds.x + x, y: bounds.y + y }],
    });
  }
  await input.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await input.detach();
  const inkWidth = await canvas.evaluate((element) => {
    const c = element as HTMLCanvasElement,
      pixels = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let left = c.width,
      right = -1;
    for (let y = 0; y < c.height; y++)
      for (let x = 0; x < c.width; x++)
        if (pixels[(y * c.width + x) * 4 + 3] > 0) {
          left = Math.min(left, x);
          right = Math.max(right, x);
        }
    return (right - left) / devicePixelRatio;
  });
  // The smoothed curve ends before its final control point. This still proves
  // the complete gesture was captured, rather than only its first short segment.
  expect(inkWidth).toBeGreaterThan(150);
  await expect(
    page.getByRole("button", { name: "Save signature", exact: true }),
  ).toBeEnabled();
  await page.setViewportSize({ width: 430, height: 844 });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: ".impeccable/review/drawing-mobile.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Save signature", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Touch signature" }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Touch signature" }),
  ).toBeVisible();
  const saved = await page.evaluate(async () =>
    (await fetch("/api/signatures")).json(),
  );
  expect(saved[0].width).toBeGreaterThan(saved[0].height);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: ".impeccable/review/signatures-mobile.png",
    fullPage: true,
  });
  await context.close();
});
