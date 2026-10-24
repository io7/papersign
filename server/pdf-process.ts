// Invoked in a separate, time-limited process: uploaded PDFs never parse on the HTTP event loop.
import { readFile, writeFile } from "node:fs/promises";
import {
  PDFDocument,
  pushGraphicsState,
  popGraphicsState,
  concatTransformationMatrix,
  StandardFonts,
} from "pdf-lib";
import type { FrozenPlacement } from "../shared/types.js";
import { fitPdfText } from "../shared/pdf-text.js";
import { join, basename } from "node:path";
const [operation, input, output, layersFile, dataDir] = process.argv.slice(2);
const pdf = await PDFDocument.load(await readFile(input), {
  updateMetadata: false,
});
if (pdf.getPageCount() < 1 || pdf.getPageCount() > 100)
  throw new Error("PDFs must have between 1 and 100 pages.");
const pages = pdf.getPages().map((page) => {
  const crop = page.getCropBox();
  const rotation = ((page.getRotation().angle % 360) + 360) % 360;
  if (
    ![0, 90, 180, 270].includes(rotation) ||
    crop.width <= 0 ||
    crop.height <= 0 ||
    crop.width > 14400 ||
    crop.height > 14400
  )
    throw new Error("Unsupported PDF page size or rotation.");
  return {
    width: rotation % 180 ? crop.height : crop.width,
    height: rotation % 180 ? crop.width : crop.height,
    rotation,
  };
});
if (operation === "inspect") await writeFile(output, JSON.stringify(pages));
else if (operation === "stamp") {
  const layers = JSON.parse(
    await readFile(layersFile, "utf8"),
  ) as FrozenPlacement[];
  const font = layers.some((layer) => layer.kind === "text")
    ? await pdf.embedFont(StandardFonts.Helvetica)
    : undefined;
  for (const layer of layers) {
    const page = pdf.getPage(layer.pageIndex),
      { width, height, rotation } = pages[layer.pageIndex];
    const box = page.getCropBox();
    const matrix: [number, number, number, number, number, number] =
      rotation === 90
        ? [0, 1, -1, 0, box.x + box.width, box.y]
        : rotation === 180
          ? [-1, 0, 0, -1, box.x + box.width, box.y + box.height]
          : rotation === 270
            ? [0, -1, 1, 0, box.x, box.y + box.height]
            : [1, 0, 0, 1, box.x, box.y];
    page.pushOperators(
      pushGraphicsState(),
      concatTransformationMatrix(...matrix),
    );
    if (layer.kind === "text") {
      const layout = fitPdfText(
        layer.text,
        layer.fontSize,
        layer.width * width,
        layer.height * height,
      );
      page.drawText(layout.text, {
        x: layer.x * width,
        y: (1 - layer.y) * height - layout.baseline,
        size: layout.fontSize,
        font,
      });
    } else {
      if (basename(layer.imageKey) !== layer.imageKey)
        throw new Error("Invalid image key");
      const image = await pdf.embedPng(
        await readFile(join(dataDir, layer.imageKey)),
      );
      page.drawImage(image, {
        x: layer.x * width,
        y: (1 - layer.y - layer.height) * height,
        width: layer.width * width,
        height: layer.height * height,
      });
    }
    page.pushOperators(popGraphicsState());
  }
  await writeFile(output, await pdf.save({ useObjectStreams: true }));
} else throw new Error("Unknown PDF operation");
