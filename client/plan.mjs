// Turns a signing spec (signers, fields anchored to text) into the exact
// recipients and owner text placements PaperSign's API accepts.
import { randomUUID } from "node:crypto";
import {
  closePdf,
  findAnchor,
  loadLayout,
  openPdf,
  placeBox,
} from "./anchors.mjs";

const SIGNATURE = {
  width: 180,
  height: () => 40,
  position: "above",
};
const TEXT = {
  width: 160,
  height: (anchor) => Math.max(14, (anchor.bottom - anchor.top) * 1.4),
  position: "right",
};
const MAX_SIGNERS = 10,
  MAX_TEXT_FIELDS = 10;

function requireText(value, what, max) {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${what} is required.`);
  if (value.trim().length > max)
    throw new Error(`${what} can be at most ${max} characters.`);
  return value.trim();
}

function place(layout, spec, defaults, what) {
  if (!spec || typeof spec !== "object")
    throw new Error(`${what} needs an anchor.`);
  const { match, count } = findAnchor(layout, spec);
  const page = layout[match.pageIndex];
  const placed = placeBox(match, page, spec, defaults);
  return {
    ...placed,
    report: {
      what,
      page: match.pageIndex + 1,
      anchor: spec.anchor,
      matched: match.text,
      line: match.lineText,
      matches: count,
      position: spec.position ?? defaults.position,
      box: Object.fromEntries(
        Object.entries(placed.points).map(([k, v]) => [k, Math.round(v)]),
      ),
      ...(placed.moved ? { warning: "moved to stay inside the page" } : {}),
    },
  };
}

export async function planSpec(spec, pdfBytes) {
  if (!Array.isArray(spec.signers) || !spec.signers.length)
    throw new Error("Add at least one signer.");
  if (spec.signers.length > MAX_SIGNERS)
    throw new Error(`PaperSign accepts up to ${MAX_SIGNERS} signers.`);
  const pdf = await openPdf(pdfBytes);
  try {
    const layout = await loadLayout(pdf);
    const report = [];
    const emails = new Set();
    const recipients = spec.signers.map((signer, index) => {
      const name = requireText(signer.name, `Signer ${index + 1} name`, 100);
      const email = requireText(signer.email, `${name}'s email`, 254);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        throw new Error(`${name}'s email “${email}” is not an email address.`);
      if (emails.has(email.toLowerCase()))
        throw new Error(`${email} appears twice; each signer needs their own.`);
      emails.add(email.toLowerCase());
      const signature = place(
        layout,
        signer.signature,
        SIGNATURE,
        `${index + 1}. ${name}: signature`,
      );
      report.push(signature.report);
      const texts = signer.text ?? [];
      if (texts.length > MAX_TEXT_FIELDS)
        throw new Error(
          `${name} can have up to ${MAX_TEXT_FIELDS} text fields.`,
        );
      const textFields = texts.map((text) => {
        const label = requireText(text.label, `A text field for ${name}`, 80);
        const placed = place(
          layout,
          text,
          TEXT,
          `${index + 1}. ${name}: ${label}`,
        );
        report.push(placed.report);
        return {
          id: randomUUID(),
          ...placed.field,
          label,
          fontSize: text.fontSize ?? 10,
        };
      });
      return {
        name,
        email,
        field: { id: randomUUID(), ...signature.field },
        textFields,
      };
    });
    const ownerText = (spec.ownerText ?? []).map((text) => {
      const value = requireText(text.text, "Owner text", 200);
      const placed = place(layout, text, TEXT, `Your text: ${value}`);
      report.push(placed.report);
      return {
        id: randomUUID(),
        kind: "text",
        ...placed.field,
        text: value,
        fontSize: text.fontSize ?? 10,
      };
    });
    return {
      pages: layout.map((page) => ({ width: page.width, height: page.height })),
      recipients,
      ownerText,
      report,
    };
  } finally {
    await closePdf(pdf);
  }
}
