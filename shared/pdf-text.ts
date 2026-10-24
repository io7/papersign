import { StandardFontEmbedder } from "pdf-lib";

export const MIN_TEXT_FONT_SIZE = 6;
export const MAX_TEXT_FONT_SIZE = 36;
export const MAX_TEXT_LENGTH = 200;
// The embedder uses its font-name enum rather than pdf-lib's public enum.
const font = StandardFontEmbedder.for(
  "Helvetica" as Parameters<typeof StandardFontEmbedder.for>[0],
);

export interface PdfTextLayout {
  text: string;
  fontSize: number;
  width: number;
  height: number;
  ascent: number;
  // Distance from the top of the field to the text baseline, in PDF points.
  baseline: number;
}

export function normalizePdfText(value: string): string {
  const text = value.trim().normalize("NFC");
  if (!text) throw new Error("Enter text for every text field.");
  if (text.length > MAX_TEXT_LENGTH)
    throw new Error(`Keep text to ${MAX_TEXT_LENGTH} characters or fewer.`);
  if (/[\r\n\u0000-\u001f\u007f]/u.test(value))
    throw new Error("Use a single line of text without tabs or line breaks.");
  if (text.includes("\u00ad"))
    throw new Error("Remove hidden soft hyphens from the text and try again.");
  try {
    font.encodeText(text);
  } catch {
    throw new Error(
      "This text contains unsupported characters. Use Latin letters (including æ, ø and å), numbers and punctuation.",
    );
  }
  return text;
}

// The editor and PDF renderer use the same metrics. All dimensions are PDF
// points; text is left aligned, vertically centered, and only scaled uniformly.
export function fitPdfText(
  value: string,
  requestedFontSize: number,
  boxWidth: number,
  boxHeight: number,
): PdfTextLayout {
  const text = normalizePdfText(value);
  if (
    !Number.isFinite(requestedFontSize) ||
    requestedFontSize < MIN_TEXT_FONT_SIZE ||
    requestedFontSize > MAX_TEXT_FONT_SIZE
  )
    throw new Error("Choose a text size between 6 and 36 pt.");
  if (
    !Number.isFinite(boxWidth) ||
    !Number.isFinite(boxHeight) ||
    boxWidth <= 0 ||
    boxHeight <= 0
  )
    throw new Error("Enlarge the text field so the text fits.");
  // drawText emits a single PDF Tj operation with no kerning adjustments.
  // StandardFontEmbedder's whole-string metric does apply kerning, which can
  // underestimate the rendered width. Sum glyph advances to match the PDF.
  const unitWidth = Array.from(text).reduce(
    (width, character) => width + font.widthOfTextAtSize(character, 1),
    0,
  );
  // Ascender excludes accents such as the ring on Å. Use the font's full
  // bounding box instead, with at least one em above the baseline: viewers may
  // substitute standard Helvetica and place accents slightly above its AFM box.
  const unitAscent = Math.max(1, font.font.FontBBox[3] / 1000);
  const unitDescent = Math.max(0, -font.font.FontBBox[1] / 1000);
  const unitHeight = unitAscent + unitDescent;
  const fontSize = Math.min(
    requestedFontSize,
    boxWidth / unitWidth,
    boxHeight / unitHeight,
  );
  if (fontSize < MIN_TEXT_FONT_SIZE - 0.000001)
    throw new Error(
      "This text does not fit. Enlarge the field or shorten the text.",
    );
  const width = unitWidth * fontSize;
  const height = unitHeight * fontSize;
  const ascent = unitAscent * fontSize;
  return {
    text,
    fontSize,
    width,
    height,
    ascent,
    baseline: (boxHeight - height) / 2 + ascent,
  };
}
