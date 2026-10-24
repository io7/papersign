import { test, expect, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { editorFixture } from "../helpers/editor-fixture";

const signerName = "Alexandra Morgan-Smith with a long signing name";
const signerEmail = `${"longsigner".repeat(6)}@example.invalid`;

async function capturePanel(page: Page, width: number, state = "") {
  const evidenceDir = process.env.SIGNER_PANEL_EVIDENCE_DIR;
  if (!evidenceDir) return;
  await mkdir(evidenceDir, { recursive: true });
  const scroll = await page.evaluate(async () => {
    await document.fonts.ready;
    const position = { x: window.scrollX, y: window.scrollY };
    window.scrollTo(0, 0);
    return position;
  });
  const bounds = await page.locator(".editor-tools").evaluate((panel) => {
    const rect = panel.getBoundingClientRect();
    return {
      left: Math.floor(rect.left + window.scrollX),
      top: Math.floor(rect.top + window.scrollY),
      width: Math.ceil(rect.width),
      height: Math.ceil(rect.height),
    };
  });
  const screenshot = await page.screenshot({
    path: `${evidenceDir}/editor-full${state}-${width}.png`,
    fullPage: true,
    animations: "disabled",
  });
  await sharp(screenshot)
    .extract(bounds)
    .toFile(`${evidenceDir}/editor-panel${state}-${width}.png`);
  await writeFile(
    `${evidenceDir}/editor-panel${state}-${width}.json`,
    JSON.stringify({ viewportWidth: width, bounds }, null, 2),
  );
  await page.evaluate(({ x, y }) => window.scrollTo(x, y), scroll);
}

async function mockEditor(page: Page) {
  const fixture = await editorFixture(page, {
    name: "Signer panel fixture.pdf",
  });
  await fixture.open();
  return fixture.unexpectedWrites;
}

for (const width of [1440, 390, 320]) {
  test(`signer panel groups long recipient details and identifies selected fields at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const unexpectedWrites = await mockEditor(page);
    const selection = page.getByRole("toolbar");
    await page.locator(".placement").click();
    await expect(selection).toHaveAccessibleName("Signature controls");

    await page.getByRole("button", { name: "Text", exact: true }).click();
    await page
      .getByLabel("Text to add", { exact: true })
      .fill("Place and date");
    await page
      .getByRole("button", { name: "Add text to page", exact: true })
      .click();
    await expect(selection).toHaveAccessibleName("Text controls");

    await page
      .getByRole("button", { name: "Invite to sign", exact: true })
      .click();
    await page.getByLabel("Recipient name", { exact: true }).fill(signerName);
    await page.getByLabel("Recipient email", { exact: true }).fill(signerEmail);
    await page
      .getByRole("button", { name: "Add signing field", exact: true })
      .click();
    await expect(selection).toHaveAccessibleName("Signature controls");
    const signer = page
      .getByRole("list", { name: "Signer order" })
      .locator(":scope > li");
    const email = signer.locator(".recipient-email");
    const addText = signer.getByRole("button", {
      name: `Add text field for ${signerName}`,
      exact: true,
    });
    const emailBounds = (await email.boundingBox())!;
    const actionBounds = (await addText.boundingBox())!;
    expect(actionBounds.y).toBeGreaterThanOrEqual(
      emailBounds.y + emailBounds.height + 7,
    );

    await addText.click();
    await expect(selection).toHaveAccessibleName("Text field controls");
    await page
      .getByLabel("Field label", { exact: true })
      .fill("Required place and date with a longer field label");
    await expect(
      signer.getByRole("list", { name: "Text fields", exact: true }),
    ).toBeVisible();

    const layout = await page.locator(".editor-tools").evaluate((panel) => {
      const bounds = panel.getBoundingClientRect();
      return {
        width: bounds.width,
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
        overflow: [
          ...panel.querySelectorAll(
            "button, input, select, .recipient-email, .hint",
          ),
        ]
          .map((element) => ({
            text: element.textContent,
            bounds: element.getBoundingClientRect(),
          }))
          .filter(
            ({ bounds: child }) =>
              child.right > bounds.right + 1 || child.left < bounds.left - 1,
          )
          .map(({ text }) => text),
      };
    });
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
    expect(layout.overflow).toEqual([]);
    if (width === 1440) expect(layout.width).toBeLessThanOrEqual(320);
    await testInfo.attach("signer-panel-layout", {
      body: JSON.stringify(layout, null, 2),
      contentType: "application/json",
    });

    await capturePanel(page, width);

    // Keyboard removal still applies to the selected recipient text field.
    await page.locator(".placement.active").press("Delete");
    await expect(
      signer.getByRole("list", { name: "Text fields", exact: true }),
    ).toHaveCount(0);
    await expect(selection).toHaveCount(0);
    await signer
      .getByRole("button", {
        name: `Position signing field for ${signerName}`,
        exact: true,
      })
      .click();
    await expect(selection).toHaveAccessibleName("Signature controls");
    await capturePanel(page, width, "-signing-field");
    await selection
      .getByRole("button", { name: "Remove from page", exact: true })
      .click();
    await expect(page.getByRole("list", { name: "Signer order" })).toHaveCount(
      0,
    );
    await expect(page.locator(".placement")).toHaveCount(2);
    expect(unexpectedWrites).toEqual([]);
  });
}
