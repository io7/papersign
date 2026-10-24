import { verifyBrowserRecipient } from "../helpers/signer-verification.js";
import { SIGNING_CONSENT } from "../../shared/signing-consent.js";
import { declareTermsComplete } from "../helpers/owner-signing.js";
import { assertTestMail } from "../helpers/test-mail.js";
import { verifyFixtureEmail } from "../helpers/account-security.js";
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import {
  PDFDocument,
  PDFRawStream,
  StandardFonts,
  decodePDFRawStream,
} from "pdf-lib";
import { signaturePng } from "../fixtures";

test.use({ actionTimeout: 10000 });

const artifacts = ".local/qa";
async function capture(page: Page, name: string) {
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    window.scrollTo(0, 0);
  });
  const stageHeight = await page
    .locator(".pdf-stage")
    .evaluateAll((elements) => elements[0]?.clientHeight);
  await page.screenshot({
    path: `${artifacts}/text-${name}.png`,
    fullPage: true,
    style: stageHeight
      ? `.pdf-stage { max-height: ${stageHeight}px !important; }`
      : undefined,
  });
}
async function register(page: Page) {
  const email = `text-browser-${randomUUID()}@example.invalid`;
  const password = `Text-browser-${randomUUID()}!`;
  await page.goto("/register");
  await page
    .getByLabel("Your name", { exact: true })
    .fill("Text workflow owner");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  const created = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/auth/sign-up/email") &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  const registration = await created;
  expect(registration.status()).toBe(200);
  await verifyFixtureEmail((await registration.json()).user.id, email);
  await page.goto("/login");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/documents$/);
  if (process.env.TEST_ACCOUNT_LOG) {
    const session = await page.evaluate(async () =>
      (await fetch("/api/auth/get-session")).json(),
    );
    await appendFile(
      process.env.TEST_ACCOUNT_LOG,
      JSON.stringify({
        id: session.user.id,
        email: session.user.email,
        name: session.user.name,
      }) + "\n",
      { mode: 0o600 },
    );
  }
}
async function fixture() {
  const pdf = await PDFDocument.create(),
    page = pdf.addPage([600, 360]);
  const font = await pdf.embedFont(StandardFonts.Helvetica),
    bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  for (const [x, company, name] of [
    [36, "For Example North AS", "Maya Patel"],
    [330, "For Example South AS", "Jordan Lee"],
  ] as const) {
    page.drawText(company, { x, y: 320, size: 12, font: bold });
    page.drawLine({
      start: { x, y: 245 },
      end: { x: x + 234, y: 245 },
      thickness: 0.6,
    });
    page.drawText(`Name: ${name}`, { x, y: 224, size: 11, font });
    page.drawText("Title: Managing Director", { x, y: 206, size: 11, font });
    page.drawText("Place/date:", { x, y: 184, size: 11, font });
  }
  page.drawText(
    "Synthetic acceptance fixture only. This is not a real agreement.",
    { x: 36, y: 124, size: 11, font },
  );
  page.drawText(
    "Each signer reviews the current document and completes their own place/date.",
    { x: 36, y: 106, size: 11, font },
  );
  return Buffer.from(await pdf.save());
}
async function moveActive(page: Page, x: number, y: number) {
  const placement = page.locator(".placement.editable.active");
  await expect(placement).toHaveCount(1);
  const box = (await placement.boundingBox())!,
    overlay = (await page.locator(".pdf-overlay").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    overlay.x + x * overlay.width + box.width / 2,
    overlay.y + y * overlay.height + box.height / 2,
    { steps: 5 },
  );
  await page.mouse.up();
}
async function shrinkTextToColumn(page: Page) {
  const field = page.locator(".placement.editable.active");
  await field.focus();
  for (let index = 0; index < 20; index++)
    await page.keyboard.press("Alt+ArrowLeft");
}
async function uploadSignature(page: Page) {
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

test("add owner text and required place/date, then preserve it through serial signing and downloads", async ({
  page,
  browser,
}, testInfo) => {
  const local = /^(127\.0\.0\.1|localhost)$/.test(
    new URL(testInfo.project.use.baseURL!).hostname,
  );
  expect(
    local || Boolean(process.env.TEST_ACCOUNT_LOG),
    "Remote acceptance must record exact synthetic account IDs for cleanup",
  ).toBe(true);
  await mkdir(artifacts, { recursive: true });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await assertTestMail(testInfo.project.use.baseURL!);
  await register(page);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.getByLabel("Upload PDF", { exact: true }).setInputFiles({
    name: "Place and date agreement.pdf",
    mimeType: "application/pdf",
    buffer: await fixture(),
  });
  await expect(page.locator(".pdf-overlay")).toBeVisible();
  const viewerGeometry = await page.evaluate(() => {
    const workspace = document.querySelector(
      ".document-workspace",
    ) as HTMLElement;
    const stage = document.querySelector(".pdf-stage") as HTMLElement;
    const hint = document.querySelector(".canvas-hint") as HTMLElement;
    const sheet = document.querySelector(".pdf-page-container") as HTMLElement;
    const style = getComputedStyle(workspace),
      rectangle = workspace.getBoundingClientRect();
    const center = (element: HTMLElement) => {
      const bounds = element.getBoundingClientRect();
      return bounds.x + bounds.width / 2;
    };
    return {
      stageWidth: stage.getBoundingClientRect().width,
      workspaceContentWidth:
        rectangle.width -
        parseFloat(style.paddingLeft) -
        parseFloat(style.paddingRight) -
        parseFloat(style.borderLeftWidth) -
        parseFloat(style.borderRightWidth),
      stageCenter: center(stage),
      hintCenter: center(hint),
      pageCenter: center(sheet),
      scrollbarGutter: getComputedStyle(stage).scrollbarGutter,
    };
  });
  expect(viewerGeometry.stageWidth).toBeGreaterThan(850);
  expect(
    Math.abs(viewerGeometry.stageWidth - viewerGeometry.workspaceContentWidth),
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs(viewerGeometry.stageCenter - viewerGeometry.hintCenter),
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs(viewerGeometry.stageCenter - viewerGeometry.pageCenter),
  ).toBeLessThanOrEqual(1);
  expect(viewerGeometry.scrollbarGutter).toBe("stable both-edges");
  const documentUrl = page.url(),
    documentId = documentUrl.split("/").pop();
  await page.getByRole("button", { name: "Text", exact: true }).click();
  await page.getByLabel("Text to add", { exact: true }).fill("Temporary text");
  await page
    .getByRole("button", { name: "Add text to page", exact: true })
    .click();
  await page.locator(".placement.editable.active").focus();
  await page.keyboard.press("Delete");
  await expect(page.locator(".placement.editable")).toHaveCount(0);
  await page
    .getByLabel("Text to add", { exact: true })
    .fill("Tromsø  /  21.10.2026");
  await page
    .getByRole("button", { name: "Add text to page", exact: true })
    .click();
  await shrinkTextToColumn(page);
  await moveActive(page, 0.66, 0.46);
  const textInput = page.getByLabel("Text", { exact: true });
  await textInput.fill("XTromsø  /  21.10.2026");
  await textInput.press("Home");
  await textInput.press("Delete");
  await expect(textInput).toHaveValue("Tromsø  /  21.10.2026");
  await expect(page.locator(".placement.editable")).toHaveCount(1);
  await expect(
    page.getByRole("status").filter({ hasText: "All page edits saved" }),
  ).toBeVisible();
  await page.reload();
  await expect(page.locator(".pdf-text-preview text")).toHaveText(
    "Tromsø  /  21.10.2026",
  );
  expect(
    await page
      .locator(".pdf-text-preview text")
      .evaluate((element) => (element as SVGTextElement).getNumberOfChars()),
  ).toBe("Tromsø  /  21.10.2026".length);
  await page.locator(".placement.text-placement").click();
  await capture(page, "editor-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  await capture(page, "editor-mobile");
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page
    .getByRole("button", { name: "Invite to sign", exact: true })
    .click();
  const recipientEmails = [0, 1].map(
    (index) => `text-${index}-${randomUUID()}@example.invalid`,
  );
  for (const [index, name] of ["Maya Patel", "Jordan Lee"].entries()) {
    await page.getByLabel("Recipient name", { exact: true }).fill(name);
    await page
      .getByLabel("Recipient email", { exact: true })
      .fill(recipientEmails[index]);
    await page
      .getByRole("button", { name: "Add signing field", exact: true })
      .click();
    await moveActive(page, index ? 0.55 : 0.06, 0.19);
  }
  await page
    .getByRole("button", { name: "Add text field for Maya Patel", exact: true })
    .click();
  await expect(page.getByLabel("Field label", { exact: true })).toHaveValue(
    "Place / date",
  );
  await shrinkTextToColumn(page);
  await moveActive(page, 0.18, 0.46);
  await capture(page, "owner-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await capture(page, "owner-mobile");
  await page.setViewportSize({ width: 1920, height: 1080 });
  await declareTermsComplete(page);
  await page
    .getByRole("button", { name: "Create signing links", exact: true })
    .click();
  const firstUrl = await page
    .getByRole("textbox", { name: "Signing link for Maya Patel", exact: true })
    .inputValue();
  const secondUrl = await page
    .getByRole("textbox", { name: "Signing link for Jordan Lee", exact: true })
    .inputValue();
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
  await expect(second.getByLabel("Place / date", { exact: true })).toHaveCount(
    0,
  );
  await first.goto(firstUrl);
  await verifyBrowserRecipient(first, recipientEmails[0]);
  await expect(
    first.getByRole("heading", { name: "Review and sign", exact: true }),
  ).toBeVisible();
  await uploadSignature(first);
  const consent = first.getByLabel(SIGNING_CONSENT.text);
  await consent.check();
  await expect(
    first.getByRole("button", { name: "Agree and sign", exact: true }),
  ).toBeDisabled();
  const placeDate = first.getByRole("textbox", {
    name: "Place / date",
    exact: true,
  });
  await placeDate.fill("London  /  21.10.2026");
  await expect(consent).not.toBeChecked();
  await expect(first.locator(".pdf-text-preview text")).toHaveText(
    "London  /  21.10.2026",
  );
  await consent.check();
  await expect(
    first.getByRole("button", { name: "Agree and sign", exact: true }),
  ).toBeEnabled();
  await capture(first, "guest-desktop");
  await first.setViewportSize({ width: 390, height: 844 });
  expect(
    await first.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await placeDate.fill("London  /  22.10.2026");
  await expect(consent).not.toBeChecked();
  await expect(first.locator(".pdf-text-preview text")).toHaveText(
    "London  /  22.10.2026",
  );
  expect(
    await first
      .locator(".pdf-text-preview text")
      .evaluate((element) => (element as SVGTextElement).getNumberOfChars()),
  ).toBe("London  /  22.10.2026".length);
  await consent.check();
  await capture(first, "guest-mobile");
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
  await verifyBrowserRecipient(second, recipientEmails[1]);
  await expect(
    second.getByRole("heading", { name: "Review and sign", exact: true }),
  ).toBeVisible();
  await expect(second.getByLabel("Place / date", { exact: true })).toHaveCount(
    0,
  );
  const reviewHref = await second
    .getByRole("link", { name: "Open PDF in a new tab", exact: true })
    .getAttribute("href");
  const review = await second.request.get(
    new URL(reviewHref!, second.url()).href,
  );
  expect(review.status()).toBe(200);
  await writeFile(
    `${artifacts}/text-browser-second-review.pdf`,
    await review.body(),
  );
  // Text extraction folds consecutive spaces. Check the actual PDF
  // text operators as well as the browser's SVG character count.
  const reviewedPdf = await PDFDocument.load(await review.body());
  const streams = reviewedPdf.context
    .enumerateIndirectObjects()
    .filter(([, object]) => object instanceof PDFRawStream)
    .map(([, object]) => {
      try {
        return Buffer.from(
          decodePDFRawStream(object as PDFRawStream).decode(),
        ).toString("latin1");
      } catch {
        return "";
      }
    })
    .join("\n");
  for (const value of ["Tromsø  /  21.10.2026", "London  /  22.10.2026"])
    expect(streams.toUpperCase()).toContain(
      Buffer.from(value, "latin1").toString("hex").toUpperCase(),
    );
  const proof = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "tests/check_text_pdf.mjs",
        `${artifacts}/text-browser-second-review.pdf`,
      ],
      { encoding: "utf8" },
    ),
  );
  expect(proof.text).toContain("Tromsø / 21.10.2026");
  expect(proof.text).toContain("London / 22.10.2026");
  await capture(second, "second-review-desktop");
  await uploadSignature(second);
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
  await capture(page, "completed-desktop");
  const download = async (filename: string) => {
    const link = page.getByRole("link", {
      name: "Download signed PDF",
      exact: true,
    });
    await expect(link).toBeVisible({ timeout: 30000 });
    const pending = page.waitForEvent("download");
    await link.click();
    const path = `${artifacts}/${filename}`;
    await (await pending).saveAs(path);
    return JSON.parse(
      execFileSync(process.execPath, ["tests/check_text_pdf.mjs", path], {
        encoding: "utf8",
      }),
    );
  };
  await page
    .getByRole("button", { name: "Prepare download", exact: true })
    .click();
  const normalProof = await download("text-browser-completed-normal.pdf");
  expect(normalProof.text).toContain("Tromsø / 21.10.2026");
  expect(normalProof.text).toContain("London / 22.10.2026");
  await page
    .getByRole("button", { name: "Advanced download", exact: true })
    .click();
  const advanced = page.getByRole("dialog", {
    name: "Advanced download",
    exact: true,
  });
  await advanced.getByLabel("Rasterize the download", { exact: true }).check();
  await advanced
    .getByRole("button", { name: "Prepare download", exact: true })
    .click();
  const rasterProof = await download("text-browser-completed-raster.pdf");
  expect(rasterProof.pages).toBe(1);
  expect(rasterProof.text).toBe("");
  await writeFile(
    `${artifacts}/text-browser-proof.json`,
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        documentId,
        desktop: { width: 1920, height: 1080 },
        mobile: { width: 390, height: 844 },
        ownerText: "Tromsø  /  21.10.2026",
        recipientText: "London  /  22.10.2026",
        ownerTextReloaded: true,
        deleteGuardPassed: true,
        guestEditClearedConsent: true,
        laterSignerPdfIncludesBothTexts: true,
        normalDownloadIncludesBothTexts: true,
        rasterDownloadHasNoTextLayer: true,
        viewerGeometry,
        errors,
      },
      null,
      2,
    ),
  );
  expect(errors).toEqual([]);
  await firstContext.close();
  await secondContext.close();
});
