import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createCanvas } from "@napi-rs/canvas";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import sharp from "sharp";

// These checks inspect exported files, not application internals. Rendering
// shares PDF.js with the raster worker; Poppler acceptance provides the separate
// rendering-engine oracle when the raster implementation changes.
const assets = new URL("./", import.meta.resolve("pdfjs-dist/package.json"));

export async function withPdfs(paths, inspect) {
  const tasks = [];
  try {
    const documents = [];
    for (const path of paths) {
      const task = getDocument({
        data: new Uint8Array(await readFile(path)),
        standardFontDataUrl: fileURLToPath(new URL("standard_fonts/", assets)),
        cMapUrl: fileURLToPath(new URL("cmaps/", assets)),
        cMapPacked: true,
        wasmUrl: fileURLToPath(new URL("wasm/", assets)),
        iccUrl: fileURLToPath(new URL("iccs/", assets)),
        useSystemFonts: false,
        isEvalSupported: false,
      });
      tasks.push(task);
      documents.push(await task.promise);
    }
    return await inspect(...documents);
  } finally {
    await Promise.all(tasks.map((task) => task.destroy()));
  }
}

export async function pageText(document, index) {
  const page = await document.getPage(index + 1);
  const content = await page.getTextContent();
  return content.items
    .filter((item) => "str" in item)
    .map((item) => item.str + (item.hasEOL ? "\n" : ""))
    .join("");
}

export async function documentText(document) {
  const text = [];
  for (let index = 0; index < document.numPages; index++)
    text.push(await pageText(document, index));
  return text.join("\n");
}

export async function textLength(document) {
  let length = 0;
  for (let index = 0; index < document.numPages; index++)
    length += (await pageText(document, index)).length;
  return length;
}

export async function renderPage(document, index) {
  const page = await document.getPage(index + 1);
  const viewport = page.getViewport({ scale: 1 });
  const width = Math.ceil(viewport.width),
    height = Math.ceil(viewport.height);
  const canvas = createCanvas(width, height);
  try {
    const context = canvas.getContext("2d");
    await page.render({ canvasContext: context, viewport }).promise;
    return {
      width,
      height,
      data: context.getImageData(0, 0, width, height).data,
    };
  } finally {
    canvas.width = canvas.height = 1;
  }
}

export async function resizeTo(image, reference) {
  if (image.width === reference.width && image.height === reference.height)
    return image;
  return {
    width: reference.width,
    height: reference.height,
    data: await sharp(image.data, {
      raw: { width: image.width, height: image.height, channels: 4 },
    })
      .resize(reference.width, reference.height, { kernel: "cubic" })
      .raw()
      .toBuffer(),
  };
}

// Preserve the previous checker's nearest-even coordinate rounding.
export function round(value) {
  const floor = Math.floor(value);
  return value - floor === 0.5 ? floor + (floor % 2) : Math.round(value);
}

export function fieldBox(field, image) {
  return [
    round(field.x * image.width),
    round(field.y * image.height),
    round((field.x + field.width) * image.width),
    round((field.y + field.height) * image.height),
  ];
}

export function eachPixel(image, box, inspect) {
  const [left, top, right, bottom] = box;
  for (let y = top; y < bottom; y++)
    for (let x = left; x < right; x++) {
      const offset = (y * image.width + x) * 4;
      inspect(
        image.data[offset],
        image.data[offset + 1],
        image.data[offset + 2],
        x,
        y,
        offset,
      );
    }
}

export function countPixels(image, box, predicate) {
  let count = 0;
  eachPixel(image, box, (...pixel) => {
    if (predicate(...pixel)) count++;
  });
  return count;
}

export const redInk = (r, g, b) => r > 170 && g < 110 && b < 110;

export function pixelDifference(a, b, offset) {
  return [0, 1, 2].map((channel) =>
    Math.abs(a.data[offset + channel] - b.data[offset + channel]),
  );
}
