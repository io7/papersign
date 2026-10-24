import {
  countPixels,
  pageText,
  renderPage,
  round,
  withPdfs,
} from "./helpers/pdf-inspection.mjs";

const proof = [];
for (const mode of ["normal", "raster"])
  proof.push(
    await withPdfs(
      [`.local/qa/white-background-${mode}.pdf`],
      async (document) => {
        const image = await renderPage(document, 0);
        const regions = [0.2, 0.55].map((top) => {
          const box = [60, round(top * 800), 300, round((top + 0.15) * 800)];
          return {
            whiteHaloPixels: countPixels(
              image,
              box,
              (r, g, b) => r > 65 && g > 116 && b > 162,
            ),
            backgroundPixels: countPixels(
              image,
              box,
              (r, g, b) =>
                Math.abs(r - 46) < 3 &&
                Math.abs(g - 97) < 3 &&
                Math.abs(b - 143) < 3,
            ),
            blackInkPixels: countPixels(
              image,
              box,
              (r, g, b) => r < 15 && g < 15 && b < 15,
            ),
            blueInkPixels: countPixels(
              image,
              box,
              (r, g, b) => r < 15 && g > 40 && g < 85 && b > 170,
            ),
          };
        });
        return {
          mode,
          regions,
          textLength: (await pageText(document, 0)).length,
        };
      },
    ),
  );
console.log(JSON.stringify(proof));
