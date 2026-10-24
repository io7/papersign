// Uploaded PDFs render in a separate, time-limited Node process, never on the HTTP event loop.
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas } from "@napi-rs/canvas";
import { PDFDocument } from "pdf-lib";
import { AnnotationMode, getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const [input, output] = process.argv.slice(2);
const assets = dirname(
  fileURLToPath(import.meta.resolve("pdfjs-dist/package.json")),
);
const source = getDocument({
  data: new Uint8Array(await readFile(input)),
  cMapUrl: join(assets, "cmaps") + sep,
  standardFontDataUrl: join(assets, "standard_fonts") + sep,
  wasmUrl: join(assets, "wasm") + sep,
  iccUrl: join(assets, "iccs") + sep,
  useSystemFonts: false,
  useWorkerFetch: false,
  stopAtErrors: true,
});

try {
  const document = await source.promise;
  if (document.numPages < 1 || document.numPages > 100)
    throw new Error("PDFs must have between 1 and 100 pages.");
  const result = await PDFDocument.create();
  for (let index = 1; index <= document.numPages; index++) {
    const page = await document.getPage(index);
    // PDF.js resolves the crop box, rotation and UserUnit into the viewport.
    const size = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: 200 / 72 });
    const width = Math.ceil(viewport.width),
      height = Math.ceil(viewport.height);
    if (
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width <= 0 ||
      height <= 0 ||
      width * height > 25_000_000
    )
      throw new Error("A page is too large to rasterize safely at 200 DPI.");
    const canvas = createCanvas(width, height);
    try {
      await page.render({
        canvas: canvas as unknown as HTMLCanvasElement,
        viewport,
        annotationMode: AnnotationMode.ENABLE,
        background: "rgb(255,255,255)",
      }).promise;
      const image = await result.embedPng(await canvas.encode("png"));
      result.addPage([size.width, size.height]).drawImage(image, {
        x: 0,
        y: 0,
        width: size.width,
        height: size.height,
      });
      // Discard the decoded image after embedding; process one canvas at a time.
      await image.embed();
    } finally {
      canvas.width = 0;
      canvas.height = 0;
      page.cleanup();
    }
  }
  await writeFile(output, await result.save(), { mode: 0o600 });
} finally {
  await source.destroy();
}
