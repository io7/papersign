// Renders the pages that carry fields, with every box drawn and labelled, so a
// person (or Claude) can check placement before anything is sent.
import { createCanvas } from "@napi-rs/canvas";
import { closePdf, openPdf } from "./anchors.mjs";

const COLOURS = ["#1f6feb", "#c2410c", "#15803d", "#7c3aed", "#be123c"];

export function previewBoxes(plan) {
  const boxes = [];
  plan.recipients.forEach((recipient, index) => {
    const colour = COLOURS[index % COLOURS.length];
    boxes.push({
      ...recipient.field,
      colour,
      label: `${index + 1}. ${recipient.name}: signature`,
    });
    for (const text of recipient.textFields)
      boxes.push({ ...text, colour, label: `${index + 1}. ${text.label}` });
  });
  for (const text of plan.ownerText)
    boxes.push({
      ...text,
      colour: "#475569",
      label: `Your text: ${text.text}`,
    });
  return boxes;
}

export async function renderPreviews(pdfBytes, boxes, scale = 1.5) {
  const pdf = await openPdf(pdfBytes);
  const images = [];
  try {
    const pageIndexes = [...new Set(boxes.map((box) => box.pageIndex))].sort(
      (a, b) => a - b,
    );
    for (const pageIndex of pageIndexes) {
      const page = await pdf.getPage(pageIndex + 1);
      const viewport = page.getViewport({ scale });
      const canvas = createCanvas(
        Math.ceil(viewport.width),
        Math.ceil(viewport.height),
      );
      await page.render({
        canvas,
        viewport,
        background: "rgb(255,255,255)",
      }).promise;
      const context = canvas.getContext("2d");
      for (const box of boxes.filter((item) => item.pageIndex === pageIndex)) {
        const x = box.x * viewport.width,
          y = box.y * viewport.height,
          w = box.width * viewport.width,
          h = box.height * viewport.height;
        context.fillStyle = `${box.colour}1f`;
        context.fillRect(x, y, w, h);
        context.strokeStyle = box.colour;
        context.lineWidth = 2;
        context.strokeRect(x, y, w, h);
        // The label stays inside its box so it never hides the document text.
        const size = Math.max(7, Math.min(10 * scale, h - 4));
        context.font = `${Math.round(size)}px sans-serif`;
        context.fillStyle = box.colour;
        context.fillText(
          box.label,
          x + 4,
          y + Math.min(h - 3, size + 2),
          w - 8,
        );
      }
      images.push({ pageIndex, png: await canvas.encode("png") });
      page.cleanup();
    }
  } finally {
    await closePdf(pdf);
  }
  return images;
}
