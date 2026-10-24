import { readFile } from "node:fs/promises";
import {
  countPixels,
  documentText,
  eachPixel,
  fieldBox,
  pixelDifference,
  renderPage,
  resizeTo,
  textLength,
  withPdfs,
} from "./helpers/pdf-inspection.mjs";

const paths = process.argv.slice(2);
const proof = await withPdfs(
  paths.length === 1 ? paths : paths.slice(0, 3),
  async (normal, raster, original) => {
    const allText = await documentText(normal);
    if (paths.length === 1) return { pages: normal.numPages, text: allText };
    const fields = JSON.parse(await readFile(paths[3], "utf8"));
    const fieldProof = [],
      images = new Map(),
      boxesByPage = new Map();
    for (const field of fields) {
      const index = field.pageIndex;
      if (!images.has(index)) {
        const rendered = await renderPage(normal, index);
        images.set(index, [
          rendered,
          await resizeTo(await renderPage(raster, index), rendered),
          await renderPage(original, index),
        ]);
      }
      const [rendered, flattened, base] = images.get(index);
      const box = fieldBox(field, rendered);
      if (!boxesByPage.has(index)) boxesByPage.set(index, []);
      boxesByPage.get(index).push(box);
      let changed = 0,
        difference = 0;
      eachPixel(rendered, box, (_r, _g, _b, _x, _y, offset) => {
        if (Math.max(...pixelDifference(rendered, base, offset)) > 30)
          changed++;
        difference += pixelDifference(rendered, flattened, offset).reduce(
          (sum, channel) => sum + channel,
          0,
        );
      });
      fieldProof.push({
        pageIndex: index,
        text: field.text,
        extracted: allText.includes(field.text),
        changedPixels: changed,
        rasterInkPixels: countPixels(
          flattened,
          box,
          (r, g, b) => Math.max(r, g, b) < 160,
        ),
        meanRasterDifference:
          difference / ((box[2] - box[0]) * (box[3] - box[1]) * 3),
      });
    }
    let outside = 0;
    for (const [index, [rendered, _flattened, base]] of images)
      eachPixel(
        rendered,
        [0, 0, rendered.width, rendered.height],
        (_r, _g, _b, x, y, offset) => {
          if (
            Math.max(...pixelDifference(rendered, base, offset)) > 30 &&
            !boxesByPage
              .get(index)
              .some(
                ([left, top, right, bottom]) =>
                  left - 1 <= x &&
                  x < right + 1 &&
                  top - 1 <= y &&
                  y < bottom + 1,
              )
          )
            outside++;
        },
      );
    return {
      pages: normal.numPages,
      rasterPages: raster.numPages,
      changedPixelsOutsideFields: outside,
      rasterTextLength: await textLength(raster),
      fields: fieldProof,
    };
  },
);
console.log(JSON.stringify(proof));
