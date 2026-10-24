import { test, expect, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import type { TextPlacement } from "../../shared/types";
import {
  editorDocumentId,
  editorFixture,
  editorPlacementId,
} from "../helpers/editor-fixture";

const textPlacement: TextPlacement = {
  id: editorPlacementId,
  kind: "text",
  text: "Place, date or name",
  fontSize: 12,
  pageIndex: 0,
  x: 0.1,
  y: 0.2,
  width: 0.35,
  height: 0.06,
};
const unexpectedWrites = new WeakMap<Page, string[]>();
test.afterEach(async ({ page }) => {
  expect(unexpectedWrites.get(page) ?? []).toEqual([]);
});

async function setup(
  page: Page,
  options?: Parameters<typeof editorFixture>[1],
) {
  const fixture = await editorFixture(page, options);
  unexpectedWrites.set(page, fixture.unexpectedWrites);
  await fixture.open();
  return fixture;
}

function saved(page: Page) {
  return page.getByRole("status").filter({ hasText: "All page edits saved" });
}

test("generic text hint and page edits save automatically after a burst of changes", async ({
  page,
}) => {
  const fixture = await setup(page);
  await expect(
    page.getByRole("button", { name: "Save positions", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Text", exact: true }).click();
  await expect(page.getByLabel("Text to add", { exact: true })).toHaveAttribute(
    "placeholder",
    "Enter text",
  );
  const field = page.locator(".placement.editable");
  await field.focus();
  await field.press("ArrowRight");
  await field.press("ArrowRight");
  await field.press("ArrowRight");
  await expect(
    page.getByRole("status").filter({ hasText: "Waiting to save…" }),
  ).toBeVisible();
  await expect(saved(page)).toBeVisible();
  expect(fixture.saves).toHaveLength(1);
  expect(fixture.document.placements[0].x).toBeCloseTo(0.115);
  expect(fixture.document.revision).toBe(2);
  await page.reload();
  await expect(page.locator(".placement.editable")).toBeVisible();
  expect(
    await page
      .locator(".placement")
      .evaluate((element) => (element as HTMLElement).style.left),
  ).toBe("11.5%");
});

test("a new edit during a slow save is preserved in a second serialized revision", async ({
  page,
}) => {
  const fixture = await setup(page);
  const hold = fixture.holdNextSave();
  const field = page.locator(".placement.editable");
  try {
    await field.focus();
    await field.press("ArrowRight");
    await hold.started;
    await expect(
      page.getByRole("status").filter({ hasText: "Saving…" }),
    ).toBeVisible();
    await field.press("ArrowRight");
    await field.press("ArrowRight");
    hold.release();
    await expect(saved(page)).toBeVisible();
    expect(fixture.saves).toHaveLength(2);
    expect(fixture.saves.map((save) => save.revision)).toEqual([1, 2]);
    expect(fixture.saves[0].placements[0].x).toBeCloseTo(0.105);
    expect(fixture.saves[1].placements[0].x).toBeCloseTo(0.115);
    expect(fixture.document.placements[0].x).toBeCloseTo(0.115);
    expect(fixture.maximumConcurrentSaves).toBe(1);
    expect(
      await field.evaluate((element) => (element as HTMLElement).style.left),
    ).toBe("11.5%");
  } finally {
    hold.release();
  }
});

test("failed autosave retains edits and offers an explicit retry", async ({
  page,
}) => {
  const fixture = await setup(page);
  fixture.failNextSave();
  const field = page.locator(".placement.editable");
  await field.focus();
  await field.press("ArrowRight");
  await expect(
    page.getByRole("status").filter({ hasText: "Changes not saved" }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toContainText(
    "The server could not save this change.",
  );
  expect(fixture.document.placements[0].x).toBe(0.1);
  expect(
    await field.evaluate((element) => (element as HTMLElement).style.left),
  ).toBe("10.5%");
  await page.getByRole("button", { name: "Retry save", exact: true }).click();
  await expect(saved(page)).toBeVisible();
  expect(fixture.saves.map((save) => save.revision)).toEqual([1, 1]);
  expect(fixture.document.placements[0].x).toBeCloseTo(0.105);
  await expect(
    page.getByRole("button", { name: "Retry save", exact: true }),
  ).toHaveCount(0);
});

test("reverting an edit during a failed request still permits retrying the latest state", async ({
  page,
}) => {
  const fixture = await setup(page);
  const hold = fixture.holdNextSave();
  fixture.failNextSave();
  const field = page.locator(".placement.editable");
  try {
    await field.focus();
    await field.press("ArrowRight");
    await hold.started;
    await field.press("ArrowLeft");
    hold.release();
    await expect(
      page.getByRole("status").filter({ hasText: "Changes not saved" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Retry save", exact: true }).click();
    await expect(saved(page)).toBeVisible();
    expect(fixture.saves.map((save) => save.revision)).toEqual([1, 1]);
    expect(fixture.document.placements[0].x).toBeCloseTo(0.1);
    await expect(
      page.getByRole("button", { name: "Retry save", exact: true }),
    ).toHaveCount(0);
  } finally {
    hold.release();
  }
});

test("a lost successful response is reconciled before saving a newer local edit", async ({
  page,
}) => {
  const fixture = await setup(page, { placements: [textPlacement] });
  const hold = fixture.holdNextSave();
  fixture.loseNextSaveResponse();
  const field = page.locator(".placement.editable");
  try {
    await field.click();
    const input = page.getByRole("toolbar").getByLabel("Text", { exact: true });
    await input.fill("Cafe\u0301 ");
    await hold.started;
    await input.fill("Cafe\u0301, London ");
    hold.release();
    await expect(saved(page)).toBeVisible();
    expect(fixture.saves.map((save) => save.revision)).toEqual([1, 2]);
    expect((fixture.saves[0].placements[0] as TextPlacement).text).toBe(
      "Cafe\u0301 ",
    );
    expect((fixture.document.placements[0] as TextPlacement).text).toBe(
      "Café, London",
    );
    expect(fixture.document.revision).toBe(3);
    expect(fixture.maximumConcurrentSaves).toBe(1);
    await expect(
      page.getByRole("button", { name: "Retry save", exact: true }),
    ).toHaveCount(0);
  } finally {
    hold.release();
  }
});

test("leaving the editor flushes changes and waits for the write before navigation", async ({
  page,
}) => {
  const fixture = await setup(page);
  const hold = fixture.holdNextSave();
  try {
    const field = page.locator(".placement.editable");
    await field.focus();
    await field.press("ArrowRight");
    await page
      .getByRole("link", { name: "Documents", exact: true })
      .last()
      .click();
    await hold.started;
    await expect(page).toHaveURL(new RegExp(`/documents/${editorDocumentId}$`));
    hold.release();
    await expect(page).toHaveURL(/\/documents$/);
    expect(fixture.saves).toHaveLength(1);
    expect(fixture.document.placements[0].x).toBeCloseTo(0.105);
    await page.getByRole("link", { name: /Editor fixture.pdf/ }).click();
    await expect(page.locator(".placement")).toBeVisible();
    expect(
      await page
        .locator(".placement")
        .evaluate((element) => (element as HTMLElement).style.left),
    ).toBe("10.5%");
  } finally {
    hold.release();
  }
});

test("text controls stay on the field, preserve typing, and deselect outside without removing the field", async ({
  page,
}) => {
  const fixture = await setup(page, { placements: [textPlacement] });
  const field = page.locator(".placement.text-placement");
  await field.click();
  const toolbar = page.getByRole("toolbar", {
    name: "Text controls",
    exact: true,
  });
  await expect(toolbar).toBeVisible();
  await expect(page.locator(".selection-tools")).toHaveCount(0);
  const input = toolbar.getByLabel("Text", { exact: true });
  await input.fill("XPlace, date or name");
  await input.press("Home");
  await input.press("Delete");
  await expect(input).toHaveValue("Place, date or name");
  await expect(field).toHaveCount(1);
  await toolbar.getByLabel("Font size", { exact: true }).selectOption("18");
  await expect(toolbar).toBeVisible();
  await expect(field).toHaveClass(/active/);
  await expect(saved(page)).toBeVisible();
  expect((fixture.document.placements[0] as TextPlacement).fontSize).toBe(18);

  await field.focus();
  await field.press("Enter");
  await expect(input).toBeFocused();
  await input.press("Escape");
  await expect(field).toBeFocused();
  await expect(toolbar).toBeVisible();

  await page
    .getByRole("heading", { name: "Editor fixture.pdf", exact: true })
    .click();
  await expect(toolbar).toHaveCount(0);
  await expect(field).not.toHaveClass(/active/);
  await expect(field).not.toBeFocused();
  await expect(input).toHaveCount(0);
  await expect(field).toHaveCount(1);

  await field.focus();
  await expect(toolbar).toBeVisible();
  await field.press("Delete");
  await expect(field).toHaveCount(0);
  await expect(toolbar).toHaveCount(0);
  await expect(saved(page)).toBeVisible();
  expect(fixture.document.placements).toEqual([]);
});

test("signature controls deselect on PDF background click and remain reusable", async ({
  page,
}) => {
  const fixture = await setup(page);
  const field = page.locator(".placement.editable");
  const toolbar = page.getByRole("toolbar", {
    name: "Signature controls",
    exact: true,
  });
  await field.click();
  await expect(toolbar).toBeVisible();
  await page.locator(".pdf-overlay").click({ position: { x: 10, y: 10 } });
  await expect(toolbar).toHaveCount(0);
  await expect(field).not.toHaveClass(/active/);
  await expect(field).not.toBeFocused();
  await page.keyboard.press("Delete");
  await expect(field).toHaveCount(1);
  await field.click();
  await expect(toolbar).toBeVisible();
  await toolbar
    .getByRole("button", { name: "Remove from page", exact: true })
    .click();
  await expect(field).toHaveCount(0);
  await expect(saved(page)).toBeVisible();
  expect(fixture.document.placements).toEqual([]);
  await page
    .getByRole("button", { name: "Add to this page", exact: true })
    .click();
  await expect(field).toHaveCount(1);
  await expect(saved(page)).toBeVisible();
  expect(fixture.document.placements).toHaveLength(1);
});

for (const width of [1440, 390, 320]) {
  test(`inline text toolbar stays reachable at PDF edges at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await setup(page, {
      placements: [
        { ...textPlacement, x: 0.78, y: 0.01, width: 0.21 },
        {
          ...textPlacement,
          id: "44444444-4444-4444-8444-444444444444",
          x: 0.01,
          y: 0.93,
        },
      ],
    });
    const toolbar = page.getByRole("toolbar", {
      name: "Text controls",
      exact: true,
    });
    for (const [index, edge] of ["top", "bottom"].entries()) {
      await page.locator(".placement.text-placement").nth(index).click();
      await expect(toolbar).toBeVisible();
      const bounds = await toolbar.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      expect(bounds!.y).toBeGreaterThanOrEqual(0);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(900);
      await toolbar.getByLabel("Font size", { exact: true }).selectOption("16");
      await expect(saved(page)).toBeVisible();
      expect(
        (fixture.document.placements[index] as TextPlacement).fontSize,
      ).toBe(16);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(width);
      if (process.env.EDITOR_REFINEMENT_EVIDENCE_DIR) {
        await mkdir(process.env.EDITOR_REFINEMENT_EVIDENCE_DIR, {
          recursive: true,
        });
        await page.screenshot({
          path: `${process.env.EDITOR_REFINEMENT_EVIDENCE_DIR}/inline-text-${edge}-${width}.png`,
          fullPage: false,
          animations: "disabled",
        });
      }
    }
  });
}
