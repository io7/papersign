// Finds text in a PDF and turns "put this box next to that text" into the
// normalized page coordinates PaperSign uses: fractions of the displayed page
// (crop box after rotation), measured from the top-left corner.
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const assets = dirname(
  fileURLToPath(import.meta.resolve("pdfjs-dist/package.json")),
);

export async function openPdf(bytes) {
  return getDocument({
    data: new Uint8Array(bytes),
    cMapUrl: join(assets, "cmaps") + sep,
    standardFontDataUrl: join(assets, "standard_fonts") + sep,
    wasmUrl: join(assets, "wasm") + sep,
    iccUrl: join(assets, "iccs") + sep,
    useSystemFonts: false,
    useWorkerFetch: false,
    isEvalSupported: false,
  }).promise;
}
export const closePdf = (pdf) => pdf.loadingTask.destroy();

const normalize = (text) => text.replace(/\s+/g, " ").trim().toLowerCase();

// Axis-aligned box of one text run in viewport space (points, top-left origin).
function runBox(viewport, item) {
  const [a, b, c, d, e, f] = item.transform;
  const along = Math.hypot(a, b) || 1,
    up = Math.hypot(c, d) || 1;
  const dir = [a / along, b / along],
    upDir = [c / up, d / up];
  const height = item.height || up;
  const corners = [
    [e, f],
    [e + dir[0] * item.width, f + dir[1] * item.width],
    [e + upDir[0] * height, f + upDir[1] * height],
    [
      e + dir[0] * item.width + upDir[0] * height,
      f + dir[1] * item.width + upDir[1] * height,
    ],
  ].map(([x, y]) => viewport.convertToViewportPoint(x, y));
  const xs = corners.map((p) => p[0]),
    ys = corners.map((p) => p[1]);
  return {
    left: Math.min(...xs),
    right: Math.max(...xs),
    top: Math.min(...ys),
    bottom: Math.max(...ys),
  };
}

// Groups text runs into visual lines and returns each line's text together
// with the character ranges each run covers.
export async function pageLines(page) {
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const runs = content.items
    .filter((item) => "str" in item && item.str.trim() && item.width > 0)
    .map((item) => ({ text: item.str, box: runBox(viewport, item) }));
  runs.sort((p, q) => p.box.top - q.box.top || p.box.left - q.box.left);
  const lines = [];
  for (const run of runs) {
    const h = run.box.bottom - run.box.top;
    const line = lines.find((candidate) => {
      const overlap =
        Math.min(candidate.box.bottom, run.box.bottom) -
        Math.max(candidate.box.top, run.box.top);
      return (
        overlap > 0.5 * Math.min(h, candidate.box.bottom - candidate.box.top)
      );
    });
    if (line) {
      line.runs.push(run);
      line.box.top = Math.min(line.box.top, run.box.top);
      line.box.bottom = Math.max(line.box.bottom, run.box.bottom);
    } else lines.push({ runs: [run], box: { ...run.box } });
  }
  return {
    width: viewport.width,
    height: viewport.height,
    lines: lines.flatMap((line) => splitColumns(line)),
  };
}

// A table row puts several cells on one visual line. Wide gaps start a new
// segment so "near" and reading order work per column.
function splitColumns(line) {
  line.runs.sort((p, q) => p.box.left - q.box.left);
  const segments = [];
  let current;
  for (const run of line.runs) {
    const h = run.box.bottom - run.box.top;
    const gap = current ? run.box.left - current.box.right : Infinity;
    if (!current || gap > 3 * h) {
      current = { text: "", spans: [], box: { ...run.box } };
      segments.push(current);
    } else if (gap > 0.15 * h && !current.text.endsWith(" "))
      current.text += " ";
    const start = current.text.length;
    current.text += run.text;
    current.spans.push({ start, end: current.text.length, box: run.box });
    current.box.left = Math.min(current.box.left, run.box.left);
    current.box.right = Math.max(current.box.right, run.box.right);
    current.box.top = Math.min(current.box.top, run.box.top);
    current.box.bottom = Math.max(current.box.bottom, run.box.bottom);
  }
  return segments;
}

// Box of characters [from, to) of a line, interpolating inside runs.
function rangeBox(line, from, to) {
  let box;
  for (const span of line.spans) {
    if (span.end <= from || span.start >= to) continue;
    const length = span.end - span.start || 1;
    const width = span.box.right - span.box.left;
    const left =
      span.box.left + (width * Math.max(0, from - span.start)) / length;
    const right =
      span.box.left + (width * (Math.min(to, span.end) - span.start)) / length;
    const part = { left, right, top: span.box.top, bottom: span.box.bottom };
    box = box
      ? {
          left: Math.min(box.left, part.left),
          right: Math.max(box.right, part.right),
          top: Math.min(box.top, part.top),
          bottom: Math.max(box.bottom, part.bottom),
        }
      : part;
  }
  return box;
}

// Maps an index in the normalized string back to the original line text.
function originalIndex(text, normalizedIndex) {
  let seen = 0,
    inSpace = false,
    started = false;
  for (let i = 0; i < text.length; i++) {
    const space = /\s/.test(text[i]);
    if (!started && space) continue;
    started = true;
    if (space) {
      if (!inSpace) {
        if (seen === normalizedIndex) return i;
        seen++;
      }
      inSpace = true;
    } else {
      if (seen === normalizedIndex) return i;
      seen++;
      inSpace = false;
    }
  }
  return text.length;
}

export async function loadLayout(pdf) {
  const pages = [];
  for (let index = 1; index <= pdf.numPages; index++) {
    const page = await pdf.getPage(index);
    pages.push(await pageLines(page));
    page.cleanup();
  }
  return pages;
}

// Every match of `text`, in reading order: page, then top, then left.
export function findAll(layout, text, page) {
  const needle = normalize(text);
  if (!needle) throw new Error("An anchor needs some text to find.");
  const matches = [];
  layout.forEach((pageLayout, pageIndex) => {
    if (page && pageIndex !== page - 1) return;
    for (const line of pageLayout.lines) {
      const haystack = normalize(line.text);
      for (
        let at = haystack.indexOf(needle);
        at !== -1;
        at = haystack.indexOf(needle, at + 1)
      ) {
        const from = originalIndex(line.text, at),
          to = originalIndex(line.text, at + needle.length - 1) + 1;
        matches.push({
          pageIndex,
          text: line.text.slice(from, to),
          lineText: line.text,
          box: rangeBox(line, from, to),
        });
      }
    }
  });
  return matches.sort(
    (p, q) =>
      p.pageIndex - q.pageIndex ||
      Math.round(p.box.top - q.box.top) ||
      p.box.left - q.box.left,
  );
}

const centre = (box) => [
  (box.left + box.right) / 2,
  (box.top + box.bottom) / 2,
];

export function findAnchor(layout, spec) {
  const matches = findAll(layout, spec.anchor, spec.page);
  if (!matches.length)
    throw new Error(`Could not find “${spec.anchor}” in the PDF.`);
  if (spec.near) {
    const targets = findAll(layout, spec.near, spec.page);
    if (!targets.length)
      throw new Error(`Could not find “${spec.near}” in the PDF.`);
    let best,
      bestDistance = Infinity;
    for (const match of matches)
      for (const target of targets) {
        if (target.pageIndex !== match.pageIndex) continue;
        const [x1, y1] = centre(match.box),
          [x2, y2] = centre(target.box);
        const distance = Math.hypot(x1 - x2, y1 - y2);
        if (distance < bestDistance) {
          best = match;
          bestDistance = distance;
        }
      }
    if (!best)
      throw new Error(
        `“${spec.anchor}” and “${spec.near}” are never on the same page.`,
      );
    return { match: best, count: matches.length };
  }
  const occurrence = spec.occurrence ?? 1;
  if (!Number.isInteger(occurrence) || occurrence < 1)
    throw new Error("occurrence counts from 1.");
  if (occurrence > matches.length)
    throw new Error(
      `“${spec.anchor}” appears ${matches.length} time(s); occurrence ${occurrence} does not exist.`,
    );
  return { match: matches[occurrence - 1], count: matches.length };
}

const GAP = 4;

// Places a box of the given size relative to an anchor. Sizes are in points.
export function placeBox(anchor, page, spec, defaults) {
  const a = anchor.box;
  const width = spec.width ?? defaults.width;
  const height = spec.height ?? defaults.height(a);
  const dx = spec.dx ?? 0,
    dy = spec.dy ?? 0;
  let left, top;
  switch (spec.position ?? defaults.position) {
    case "above":
      left = a.left;
      top = a.top - GAP - height;
      break;
    case "below":
      left = a.left;
      top = a.bottom + GAP;
      break;
    case "right":
      left = a.right + GAP;
      top = (a.top + a.bottom) / 2 - height / 2;
      break;
    case "left":
      left = a.left - GAP - width;
      top = (a.top + a.bottom) / 2 - height / 2;
      break;
    case "over":
      left = a.left;
      top = a.bottom - height;
      break;
    default:
      throw new Error(
        `position must be above, below, right, left or over, not “${spec.position}”.`,
      );
  }
  left += dx;
  top += dy;
  const box = { left, top, width, height };
  const clamped = {
    left: Math.min(Math.max(0, left), page.width - Math.min(width, page.width)),
    top: Math.min(
      Math.max(0, top),
      page.height - Math.min(height, page.height),
    ),
    width: Math.min(width, page.width),
    height: Math.min(height, page.height),
  };
  const moved =
    Math.abs(clamped.left - box.left) > 0.5 ||
    Math.abs(clamped.top - box.top) > 0.5;
  return {
    points: clamped,
    moved,
    field: {
      pageIndex: anchor.pageIndex,
      x: round(clamped.left / page.width),
      y: round(clamped.top / page.height),
      width: round(clamped.width / page.width),
      height: round(clamped.height / page.height),
    },
  };
}
const round = (value) => Math.round(value * 1e6) / 1e6;
