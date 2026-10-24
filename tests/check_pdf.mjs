import {
  eachPixel,
  redInk,
  renderPage,
  textLength,
  withPdfs,
} from "./helpers/pdf-inspection.mjs";

const proof = await withPdfs(process.argv.slice(2), async (normal, raster) => {
  const centers = [];
  for (let index = 0; index < normal.numPages; index++) {
    const image = await renderPage(normal, index);
    let left = Infinity,
      top = Infinity,
      right = -Infinity,
      bottom = -Infinity;
    eachPixel(image, [0, 0, image.width, image.height], (r, g, b, x, y) => {
      if (!redInk(r, g, b)) return;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    });
    if (!Number.isFinite(left))
      throw new Error("A signature is missing from a rotated page");
    centers.push({
      x: (left + right) / 2 / image.width,
      y: (top + bottom) / 2 / image.height,
    });
  }
  return {
    pages: raster.numPages,
    normalText: await textLength(normal),
    rasterText: await textLength(raster),
    centers,
  };
});
console.log(JSON.stringify(proof));
