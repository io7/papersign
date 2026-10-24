#!/usr/bin/env node
// PaperSign command line: plan field placement from text anchors, create
// signing requests, send invitation emails and fetch completed records.
// See docs/api-keys.md.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createClient, KEY_FILE, loadKey, serverUrl } from "./api.mjs";
import { pendingSigners, reportLines, signerLine as line } from "./format.mjs";
import { planSpec } from "./plan.mjs";
import { previewBoxes, renderPreviews } from "./preview.mjs";

const USAGE = `Usage:
  papersign plan     SPEC.json [--out DIR]      find anchors, write previews; contacts nothing
  papersign create   SPEC.json [--out DIR]      upload, add fields, create signing links; sends no email
  papersign status   DOCUMENT_ID [--links]      signers, order and progress
  papersign email    DOCUMENT_ID [--signer EMAIL]... [--dry-run]
                                                send invitation emails to pending signers
  papersign download DOCUMENT_ID OUT.pdf [--evidence OUT.tar]
  papersign cancel   DOCUMENT_ID --reason TEXT  cancel an unfinished signing request
  papersign discard  DOCUMENT_ID                move a draft or finished document to trash

Server: PAPERSIGN_URL (required except for plan).
Key: PAPERSIGN_API_KEY, or the file in PAPERSIGN_KEY_FILE (default ${KEY_FILE}).`;

async function readSpec(path) {
  const specPath = resolve(path);
  const spec = JSON.parse(await readFile(specPath, "utf8"));
  if (!spec.pdf) throw new Error("The spec needs a pdf path.");
  const pdfPath = resolve(dirname(specPath), spec.pdf);
  return {
    spec,
    pdfPath,
    pdfBytes: await readFile(pdfPath),
    name: spec.name ?? basename(pdfPath),
  };
}

async function writePlan(plan, pdfBytes, out) {
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "plan.json"), JSON.stringify(plan, null, 2));
  const images = await renderPreviews(pdfBytes, previewBoxes(plan));
  const files = [];
  for (const image of images) {
    const file = join(out, `page-${image.pageIndex + 1}.png`);
    await writeFile(file, image.png);
    files.push(file);
  }
  return files;
}

function printReport(plan) {
  for (const entry of reportLines(plan)) console.log(`  ${entry}`);
}

async function client() {
  return createClient({
    baseUrl: serverUrl(),
    key: await loadKey(),
  });
}

const signerLine = (invitation) => `  ${line(invitation)}`;

const commands = {
  async plan(args, options) {
    const { spec, pdfBytes, name } = await readSpec(args[0]);
    const plan = await planSpec(spec, pdfBytes);
    const out = resolve(options.out ?? `${name.replace(/\.pdf$/i, "")}-plan`);
    const files = await writePlan(plan, pdfBytes, out);
    console.log(`Planned ${name}:`);
    printReport(plan);
    console.log(`Previews: ${files.join(", ")}`);
  },

  async create(args, options) {
    const { spec, pdfBytes, name } = await readSpec(args[0]);
    const plan = await planSpec(spec, pdfBytes);
    if (options.out) await writePlan(plan, pdfBytes, resolve(options.out));
    const api = await client();
    const uploaded = await api.upload(pdfBytes, name);
    let revision = uploaded.revision;
    if (plan.ownerText.length)
      revision = (await api.setOwnerText(uploaded.id, revision, plan.ownerText))
        .revision;
    const links = await api.invite(uploaded.id, revision, plan.recipients);
    console.log(`Created signing request for ${name}`);
    console.log(`Document: ${uploaded.id}`);
    printReport(plan);
    for (const link of links)
      console.log(`${signerLine(link)}\n     ${link.url}`);
    console.log(
      "No email was sent. Use `papersign email` to send the invitations.",
    );
  },

  async status(args, options) {
    const document = await (await client()).document(args[0]);
    console.log(`${document.name}: ${document.status}`);
    for (const invitation of document.invitations ?? []) {
      console.log(signerLine(invitation));
      if (options.links && invitation.signingStatus !== "signed")
        console.log(`     ${invitation.url}`);
    }
  },

  async email(args, options) {
    const api = await client();
    const document = await api.document(args[0]);
    const pending = pendingSigners(document, options.signer);
    if (!pending.length) throw new Error("No pending signer matches.");
    for (const invitation of pending) {
      const preview = await api.emailPreview(document.id, invitation.id);
      if (options["dry-run"]) {
        console.log(`Would send to ${preview.to}: ${preview.subject}`);
        continue;
      }
      await api.sendEmail(document.id, invitation.id, preview.previewHash);
      console.log(`Sent to ${preview.to}: ${preview.subject}`);
    }
  },

  async download(args, options) {
    if (!args[1]) throw new Error("Give an output path for the PDF.");
    const api = await client();
    const record = await api.record(args[0]);
    if (record.state !== "ready")
      throw new Error(
        record.message ??
          `The completed record is ${record.state}, not ready yet.`,
      );
    await writeFile(resolve(args[1]), await api.recordPdf(args[0]));
    console.log(`Saved ${resolve(args[1])}`);
    if (options.evidence) {
      await writeFile(resolve(options.evidence), await api.evidence(args[0]));
      console.log(`Saved ${resolve(options.evidence)}`);
    }
    if (record.receipt)
      console.log(`Receipt fingerprint: ${JSON.stringify(record.receipt)}`);
  },

  async cancel(args, options) {
    if (!options.reason) throw new Error("Give a --reason for cancelling.");
    const api = await client();
    const document = await api.document(args[0]);
    await api.cancel(document.id, document.revision, options.reason);
    console.log(`Cancelled the signing request for ${document.name}.`);
  },

  async discard(args) {
    const api = await client();
    const document = await api.document(args[0]);
    const result = await api.discard(
      document.id,
      document.revision,
      document.name,
    );
    console.log(`${document.name}: ${result.state}.`);
  },
};

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string" },
    links: { type: "boolean" },
    signer: { type: "string", multiple: true },
    "dry-run": { type: "boolean" },
    evidence: { type: "string" },
    reason: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});
const [command, ...args] = positionals;
if (values.help || !commands[command] || !args[0]) {
  console.log(USAGE);
  process.exit(values.help ? 0 : 2);
}
try {
  await commands[command](args, values);
} catch (error) {
  console.error(`papersign ${command}: ${error.message}`);
  process.exit(1);
}
