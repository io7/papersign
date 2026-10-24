import {
  test,
  expect,
  type Page,
  type TestInfo,
  type Locator,
} from "@playwright/test";
import { PDFDocument } from "pdf-lib";
import { mkdir, writeFile } from "node:fs/promises";
import { samplePdf } from "../fixtures";
import { editorFixture } from "../helpers/editor-fixture";

const unexpectedWrites = new WeakMap<Page, string[]>();
test.afterEach(async ({ page }) => {
  expect(unexpectedWrites.get(page) ?? []).toEqual([]);
});

async function mockEditor(page: Page, bytes: Buffer) {
  const fixture = await editorFixture(page, {
    pdf: bytes,
    name: "Navigation fixture.pdf",
  });
  unexpectedWrites.set(page, fixture.unexpectedWrites);
  await fixture.open();
  const viewer = page.getByRole("region", {
    name: "Scrollable PDF document",
    exact: true,
  });
  await expect(viewer.locator(".pdf-page-container")).toHaveCount(
    fixture.document.pages.length,
  );
  return viewer;
}

async function attachGeometry(page: Page, testInfo: TestInfo) {
  const geometry = await page
    .getByRole("region", { name: "Scrollable PDF document", exact: true })
    .evaluate((element) => ({
      selected: (
        document.querySelector('[aria-label="PDF page"]') as HTMLSelectElement
      )?.value,
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      height: element.clientHeight,
      width: element.clientWidth,
      pages: [
        ...element.querySelectorAll<HTMLElement>("[data-page-index]"),
      ].map((page) => ({
        page: page.dataset.pageIndex,
        top: page.offsetTop,
        height: page.offsetHeight,
        offsetParent: (page.offsetParent as HTMLElement | null)?.className,
        canvas: Boolean(page.querySelector("canvas")),
        loaded: Boolean(page.querySelector(".pdf-overlay")),
      })),
    }));
  await testInfo.attach("page-navigation-geometry", {
    body: JSON.stringify(geometry, null, 2),
    contentType: "application/json",
  });
}

test("recipient fields resize independently while signature images keep their ratio", async ({
  page,
}, testInfo) => {
  await mkdir(".local/qa", { recursive: true });
  const pdf = await PDFDocument.create();
  pdf.addPage([600, 400]).drawText("Free-resize signing field QA", {
    x: 30,
    y: 350,
    size: 18,
  });
  const viewer = await mockEditor(page, Buffer.from(await pdf.save()));
  await expect(viewer.locator(".pdf-overlay")).toBeVisible();
  const geometry = (field: Locator) =>
    field.evaluate((element) => {
      const box = element.getBoundingClientRect(),
        area = element.parentElement!.getBoundingClientRect();
      return {
        x: (box.x - area.x) / area.width,
        y: (box.y - area.y) / area.height,
        width: box.width / area.width,
        height: box.height / area.height,
      };
    });
  const proof: {
    step: string;
    geometry: Awaited<ReturnType<typeof geometry>>;
  }[] = [];
  const record = async (step: string, field: Locator) => {
    const value = await geometry(field);
    proof.push({ step, geometry: value });
    expect(value.x).toBeGreaterThanOrEqual(-0.0001);
    expect(value.y).toBeGreaterThanOrEqual(-0.0001);
    expect(value.x + value.width).toBeLessThanOrEqual(1.0001);
    expect(value.y + value.height).toBeLessThanOrEqual(1.0001);
    return value;
  };
  const dragCorner = async (field: Locator, dx: number, dy: number) => {
    await field.focus();
    const handle = field.locator("[data-resize]");
    await handle.scrollIntoViewIfNeeded();
    const bounds = (await handle.boundingBox())!;
    // The handle straddles the page edge at the limit; use its inner corner.
    const start = { x: bounds.x + 2, y: bounds.y + 2 };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + dx, start.y + dy, { steps: 4 });
    await page.mouse.up();
  };
  try {
    const owner = viewer.locator(".placement.editable:not(.recipient)");
    const ownerBefore = await record("owner before", owner);
    await expect(owner.locator("img")).toHaveCSS("object-fit", "contain");
    await dragCorner(owner, 40, 0);
    await expect
      .poll(async () => (await geometry(owner)).width)
      .toBeGreaterThan(ownerBefore.width);
    const ownerAfter = await record("owner proportional resize", owner);
    expect(ownerAfter.height / ownerAfter.width).toBeCloseTo(
      ownerBefore.height / ownerBefore.width,
      3,
    );

    await page
      .getByRole("button", { name: "Invite to sign", exact: true })
      .click();
    await page
      .getByLabel("Recipient name", { exact: true })
      .fill("Resize reviewer");
    await page
      .getByLabel("Recipient email", { exact: true })
      .fill("resize@example.invalid");
    await page
      .getByRole("button", { name: "Add signing field", exact: true })
      .click();
    const recipient = viewer.locator(".placement.editable.recipient");
    const initial = await record("recipient before", recipient);
    await dragCorner(recipient, 60, 0);
    await expect
      .poll(async () => (await geometry(recipient)).width)
      .toBeGreaterThan(initial.width);
    const wider = await record("recipient horizontal drag", recipient);
    expect(wider.height).toBeCloseTo(initial.height, 4);
    expect(wider.x).toBeCloseTo(initial.x, 4);
    expect(wider.y).toBeCloseTo(initial.y, 4);
    await dragCorner(recipient, 0, 35);
    await expect
      .poll(async () => (await geometry(recipient)).height)
      .toBeGreaterThan(wider.height);
    const taller = await record("recipient vertical drag", recipient);
    expect(taller.width).toBeCloseTo(wider.width, 4);
    expect(taller.x).toBeCloseTo(wider.x, 4);
    expect(taller.y).toBeCloseTo(wider.y, 4);

    for (const [key, axis, other, direction] of [
      ["ArrowRight", "width", "height", 1],
      ["ArrowLeft", "width", "height", -1],
      ["ArrowDown", "height", "width", 1],
      ["ArrowUp", "height", "width", -1],
    ] as const) {
      const before = await geometry(recipient);
      await recipient.press(`Alt+${key}`);
      const after = await record(`recipient Alt+${key}`, recipient);
      expect((after[axis] - before[axis]) * direction).toBeGreaterThan(0.004);
      expect(after[other]).toBeCloseTo(before[other], 4);
      expect(after.x).toBeCloseTo(before.x, 4);
      expect(after.y).toBeCloseTo(before.y, 4);
    }

    for (const [name, viewport] of [
      ["desktop", { width: 1440, height: 1000 }],
      ["mobile", { width: 390, height: 844 }],
    ] as const) {
      await page.setViewportSize(viewport);
      await expect(viewer.locator(".pdf-overlay")).toBeVisible();
      if (name === "mobile") {
        const before = await geometry(recipient);
        await dragCorner(recipient, 20, 0);
        await expect
          .poll(async () => (await geometry(recipient)).width)
          .toBeGreaterThan(before.width);
        expect((await geometry(recipient)).height).toBeCloseTo(
          before.height,
          4,
        );
      }
      await record(`recipient ${name}`, recipient);
      await page.evaluate(() => {
        (document.activeElement as HTMLElement | null)?.blur();
        window.scrollTo(0, 0);
      });
      await page.screenshot({
        path: `.local/qa/free-resize-${name}.png`,
        fullPage: false,
      });
    }
    await dragCorner(recipient, 2000, 2000);
    const maximum = await record("recipient page-edge limits", recipient);
    expect(maximum.x + maximum.width).toBeCloseTo(1, 3);
    expect(maximum.y + maximum.height).toBeCloseTo(1, 3);
    await dragCorner(recipient, -2000, -2000);
    const minimum = await record("recipient minimum limits", recipient);
    expect(minimum.width).toBeGreaterThan(0);
    expect(minimum.height).toBeGreaterThan(0);
    expect(minimum.width).toBeLessThan(initial.width);
    expect(minimum.height).toBeLessThan(initial.height);
  } finally {
    const body = JSON.stringify(proof, null, 2);
    await writeFile(".local/qa/free-resize-geometry.json", body + "\n");
    await testInfo.attach("free-resize-geometry", {
      body,
      contentType: "application/json",
    });
  }
});

test("page selection survives rapid jumps in a mixed-rotation eight-page PDF", async ({
  page,
}, testInfo) => {
  const viewer = await mockEditor(page, await samplePdf(true, 2));
  const dropdown = page.getByLabel("PDF page", { exact: true });
  try {
    await expect(
      viewer.locator('[data-page-index="0"] .pdf-overlay'),
    ).toBeVisible();
    await viewer.evaluate((element) =>
      element.scrollTo({ top: element.scrollHeight }),
    );
    await expect(dropdown).toHaveValue("7");
    await expect(
      viewer.getByLabel("PDF page 8 preview", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Add to this page", exact: true })
      .click();
    await expect(
      viewer.locator('[data-page-index="7"] .placement.editable'),
    ).toHaveCount(1);
    await dropdown.selectOption({ value: "0" });
    await expect(
      viewer.getByLabel("PDF page 1 preview", { exact: true }),
    ).toBeVisible();
    await expect(
      viewer.locator('[data-page-index="0"] .placement.editable'),
    ).toHaveCount(1);
    await dropdown.selectOption({ value: "7" });
    await expect(dropdown).toHaveValue("7");
    await expect(
      viewer.locator('[data-page-index="7"] .placement.editable'),
    ).toHaveCount(1);
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 1440, height: 1000 },
    ]) {
      await page.setViewportSize(viewport);
      await expect(dropdown).toHaveValue("7");
      await expect(
        viewer.getByLabel("PDF page 8 preview", { exact: true }),
      ).toBeVisible();
      await testInfo.attach(`selected-page-eight-${viewport.width}`, {
        body: await page.screenshot({ fullPage: false }),
        contentType: "image/png",
      });
      await expect(dropdown).toHaveValue("7");
      await expect(
        viewer.locator('[data-page-index="7"] .placement.editable'),
      ).toHaveCount(1);
    }
  } catch (error) {
    await attachGeometry(page, testInfo);
    throw error;
  }
});

for (const count of [3, 8]) {
  test(`selected pages remain selected and painted when ${count} short pages fit together`, async ({
    page,
  }, testInfo) => {
    const pdf = await PDFDocument.create();
    for (let index = 0; index < count; index++) {
      const pdfPage = pdf.addPage([600, 20]);
      pdfPage.drawText(`Short page ${index + 1}`, { x: 10, y: 5, size: 8 });
    }
    const viewer = await mockEditor(page, Buffer.from(await pdf.save()));
    const dropdown = page.getByLabel("PDF page", { exact: true });
    try {
      expect(
        await viewer.evaluate(
          (element) => element.scrollHeight <= element.clientHeight,
        ),
      ).toBe(true);
      await dropdown.selectOption({ value: String(count - 1) });
      await expect(dropdown).toHaveValue(String(count - 1));
      await expect(
        viewer.getByLabel(`PDF page ${count} preview`, { exact: true }),
      ).toBeVisible();
      await dropdown.selectOption({ value: "0" });
      await expect(dropdown).toHaveValue("0");
      await expect(
        viewer.getByLabel("PDF page 1 preview", { exact: true }),
      ).toBeVisible();
      await expect(
        viewer.locator('[data-page-index="0"] .pdf-overlay'),
      ).toBeVisible();
      await expect
        .poll(() => viewer.locator("canvas").count())
        .toBeLessThanOrEqual(6);
    } catch (error) {
      await attachGeometry(page, testInfo);
      throw error;
    }
  });
}
