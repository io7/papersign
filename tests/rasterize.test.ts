import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createCanvas } from "@napi-rs/canvas";
import {
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  StandardFonts,
  degrees,
  rgb,
} from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import sharp from "sharp";

const execute = promisify(execFile);
let directory: string;
let sequence = 0;

async function rasterize(bytes: Uint8Array) {
  const stem = join(directory, String(sequence++));
  const input = `${stem}-original.pdf`,
    output = `${stem}-raster.pdf`;
  await writeFile(input, bytes);
  const completion = execute(
    process.execPath,
    [
      "--max-old-space-size=512",
      "--import",
      "tsx",
      "server/pdf-rasterize.ts",
      input,
      output,
    ],
    { timeout: 30000, maxBuffer: 1024 * 1024 },
  );
  return { input, output, completion };
}

async function renderFirstPage(bytes: Uint8Array) {
  const task = getDocument({
    data: Uint8Array.from(bytes),
    useSystemFonts: false,
  });
  try {
    const document = await task.promise;
    const page = await document.getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    const canvas = createCanvas(
      Math.ceil(viewport.width),
      Math.ceil(viewport.height),
    );
    await page.render({
      canvas: canvas as unknown as HTMLCanvasElement,
      viewport,
    }).promise;
    return sharp(await canvas.encode("png"))
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
  } finally {
    await task.destroy();
  }
}

async function appearancePdf() {
  const document = await PDFDocument.create();
  const page = document.addPage([300, 400]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  page.drawText("PaperSign acceptance fixture", {
    x: 20,
    y: 370,
    size: 15,
    font,
  });
  // A half-transparent red mark must blend with blue, not acquire a white box.
  page.drawRectangle({
    x: 20,
    y: 250,
    width: 120,
    height: 80,
    color: rgb(0, 0, 1),
  });
  const ink = await sharp({
    create: {
      width: 80,
      height: 60,
      channels: 4,
      background: { r: 255, g: 0, b: 0, alpha: 0.5 },
    },
  })
    .png()
    .toBuffer();
  page.drawImage(await document.embedPng(ink), {
    x: 40,
    y: 260,
    width: 80,
    height: 60,
  });

  const field = document.getForm().createTextField("signerName");
  field.setText("Alex Example");
  field.addToPage(page, {
    x: 20,
    y: 180,
    width: 180,
    height: 32,
    borderWidth: 0,
    textColor: rgb(0, 0, 0),
    backgroundColor: rgb(1, 1, 1),
    font,
  });
  document.getForm().updateFieldAppearances(font);

  const appearance = document.context.register(
    document.context.flateStream("0 0.7 0 rg 0 0 70 40 re f", {
      Type: "XObject",
      Subtype: "Form",
      BBox: [0, 0, 70, 40],
      Resources: {},
    }),
  );
  const annotation = document.context.register(
    document.context.obj({
      Type: "Annot",
      Subtype: "Stamp",
      Rect: [210, 100, 280, 140],
      F: 4,
      AP: { N: appearance },
    }),
  );
  page.node.addAnnot(annotation);
  return document.save();
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "papersign-raster-test-"));
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("Node rasterization of uploaded PDF content", () => {
  it("preserves physical page dimensions across all rotations, crop origins and UserUnit", async () => {
    const document = await PDFDocument.create();
    const expected: number[][] = [];
    for (const rotation of [0, 90, 180, 270]) {
      const page = document.addPage([320, 440]);
      page.setCropBox(20, 30, 240, 360);
      page.setRotation(degrees(rotation));
      page.drawText(`Rotation ${rotation}`, { x: 40, y: 350, size: 16 });
      expected.push(rotation % 180 ? [360, 240] : [240, 360]);
    }
    const scaled = document.addPage([160, 220]);
    scaled.setCropBox(10, 15, 120, 180);
    scaled.node.set(PDFName.of("UserUnit"), PDFNumber.of(2));
    scaled.drawText("UserUnit 2", { x: 20, y: 160, size: 12 });
    expected.push([240, 360]);
    const run = await rasterize(await document.save());
    await run.completion;
    const output = await PDFDocument.load(await readFile(run.output));
    expect(
      output.getPages().map((page) => [page.getWidth(), page.getHeight()]),
    ).toEqual(expected);
    expect(output.getPages().map((page) => page.getRotation().angle)).toEqual([
      0, 0, 0, 0, 0,
    ]);
    expect((await stat(run.output)).mode & 0o777).toBe(0o600);
  });

  it("flattens text, forms and annotations into a single image while retaining their visible appearance", async () => {
    const run = await rasterize(await appearancePdf());
    await run.completion;
    const bytes = await readFile(run.output);
    const output = await PDFDocument.load(bytes);
    expect(output.getForm().getFields()).toHaveLength(0);
    const page = output.getPage(0);
    expect(page.node.Annots()?.size() ?? 0).toBe(0);
    const resources = page.node.Resources()!;
    const fonts = resources.lookupMaybe(PDFName.of("Font"), PDFDict);
    expect(fonts?.keys().length ?? 0).toBe(0);
    const objects = resources.lookup(PDFName.of("XObject"), PDFDict);
    expect(objects.keys()).toHaveLength(1);
    const object = objects.lookup(objects.keys()[0], PDFRawStream);
    expect(object.dict.get(PDFName.of("Subtype"))).toEqual(PDFName.of("Image"));
    expect(object.dict.lookup(PDFName.of("Width"), PDFNumber).asNumber()).toBe(
      834,
    );
    expect(object.dict.lookup(PDFName.of("Height"), PDFNumber).asNumber()).toBe(
      1112,
    );
    const task = getDocument({ data: Uint8Array.from(bytes) });
    try {
      const pdf = await task.promise;
      expect(
        (await (await pdf.getPage(1)).getTextContent()).items,
      ).toHaveLength(0);
    } finally {
      await task.destroy();
    }

    const rendered = await renderFirstPage(bytes);
    const pixel = (x: number, y: number) =>
      Array.from(
        rendered.data.subarray(
          (y * rendered.info.width + x) * 3,
          (y * rendered.info.width + x) * 3 + 3,
        ),
      );
    expect(pixel(30, 100)).toEqual([0, 0, 255]);
    const blended = pixel(60, 100);
    expect(blended[0]).toBeGreaterThanOrEqual(125);
    expect(blended[0]).toBeLessThanOrEqual(130);
    expect(blended[1]).toBe(0);
    expect(blended[2]).toBeGreaterThanOrEqual(125);
    expect(blended[2]).toBeLessThanOrEqual(130);
    const stamp = pixel(240, 280);
    expect(stamp[0]).toBe(0);
    expect(stamp[1]).toBeGreaterThan(170);
    expect(stamp[2]).toBe(0);
    // Interior of the form, away from borders, must contain the rendered value.
    let textPixels = 0;
    for (let y = 190; y < 214; y++)
      for (let x = 25; x < 175; x++) {
        if (pixel(x, y).every((channel) => channel < 100)) textPixels++;
      }
    expect(textPixels).toBeGreaterThan(100);
  });

  it("accepts the 100-page boundary without dropping blank pages", async () => {
    const document = await PDFDocument.create();
    for (let index = 0; index < 100; index++) document.addPage([10, 10]);
    const run = await rasterize(await document.save());
    await run.completion;
    expect(
      (await PDFDocument.load(await readFile(run.output))).getPageCount(),
    ).toBe(100);
  });

  it("rejects documents over 100 pages without publishing partial output", async () => {
    const document = await PDFDocument.create();
    for (let index = 0; index < 101; index++) document.addPage([10, 10]);
    const run = await rasterize(await document.save());
    await expect(run.completion).rejects.toThrow("between 1 and 100 pages");
    await expect(stat(run.output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects excessive rendered pixels even when an earlier page was valid", async () => {
    const document = await PDFDocument.create();
    document.addPage([10, 10]);
    document.addPage([2000, 2000]);
    const run = await rasterize(await document.save());
    await expect(run.completion).rejects.toThrow(
      "too large to rasterize safely",
    );
    await expect(stat(run.output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects malformed input without producing a downloadable PDF", async () => {
    const run = await rasterize(Buffer.from("not a PDF"));
    await expect(run.completion).rejects.toThrow();
    await expect(stat(run.output)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
