import {
  countPixels,
  fieldBox,
  pageText,
  redInk,
  renderPage,
  withPdfs,
} from "./helpers/pdf-inspection.mjs";

const regions = [
  [0.1, 0.1],
  [0.1, 0.54],
  [0.5, 0.54],
  [0.1, 0.78],
];
const proof = [];
for (const phase of ["first", "second", "third", "completed"])
  proof.push(
    await withPdfs(
      [`.local/qa/serial-${phase}-review.pdf`],
      async (document) => {
        const image = await renderPage(document, 0);
        const counts = regions.map(([x, y]) =>
          countPixels(
            image,
            fieldBox({ x, y, width: 0.25, height: 0.08 }, image),
            redInk,
          ),
        );
        return {
          phase,
          signatures: counts.map((count) => count > 30),
          redPixelCounts: counts,
          originalTextPresent: (await pageText(document, 0)).includes(
            "PaperSign test agreement",
          ),
        };
      },
    ),
  );
console.log(JSON.stringify(proof));
