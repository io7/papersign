import { readFile, lstat, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import {
  canonicalJson,
  createReceipt,
  evidenceHash,
  hashEvidenceRecord,
  verifyEvidenceManifest,
} from "./evidence-core.js";
import type { EvidenceManifest, EvidenceReceipt } from "../shared/evidence.js";

async function verifyDirectoryWithTools(
  tools: {
    readFile: typeof readFile;
    lstat: typeof lstat;
    realpath: typeof realpath;
    resolve: typeof resolve;
    sep: string;
    canonicalJson: typeof canonicalJson;
    createReceipt: typeof createReceipt;
    evidenceHash: typeof evidenceHash;
    verifyEvidenceManifest: typeof verifyEvidenceManifest;
  },
  directory: string,
  expectedReceipt?: string,
  expectedAcceptance?: string,
) {
  const {
    readFile,
    lstat,
    realpath,
    resolve,
    sep,
    canonicalJson,
    createReceipt,
    evidenceHash,
    verifyEvidenceManifest,
  } = tools;
  const root = await realpath(directory);
  const manifest = JSON.parse(
    await readFile(resolve(root, "manifest.json"), "utf8"),
  ) as EvidenceManifest;
  verifyEvidenceManifest(manifest);
  const receipt = JSON.parse(
    await readFile(resolve(root, "receipt.json"), "utf8"),
  ) as EvidenceReceipt;
  if (canonicalJson(receipt) !== canonicalJson(createReceipt(manifest)))
    throw new Error("The receipt does not match this manifest.");
  if (
    expectedReceipt &&
    (!/^[a-f0-9]{64}$/.test(expectedReceipt) ||
      receipt.manifestSha256 !== expectedReceipt)
  )
    throw new Error(
      "This package does not match the independently retained receipt fingerprint.",
    );
  if (
    expectedAcceptance &&
    (!/^[a-f0-9]{64}$/.test(expectedAcceptance) ||
      !manifest.records.some(
        (record) =>
          record.kind === "acceptance" && record.hash === expectedAcceptance,
      ))
  )
    throw new Error(
      "This package does not contain the independently retained acceptance fingerprint.",
    );
  for (const file of manifest.files) {
    const location = await realpath(resolve(root, file.name));
    if (!location.startsWith(root + sep) || !(await lstat(location)).isFile())
      throw new Error("An evidence file is outside the package directory.");
    const bytes = await readFile(location);
    if (bytes.length !== file.size || evidenceHash(bytes) !== file.sha256)
      throw new Error(`Evidence file changed: ${file.name}`);
  }
  return {
    receipt,
    filesVerified: manifest.files.length,
    outcome: manifest.outcome,
    independentlyMatched: Boolean(expectedReceipt || expectedAcceptance),
    anchorScope: expectedReceipt
      ? "complete-record"
      : expectedAcceptance
        ? "acceptance-only"
        : "none",
  };
}

export function verifyEvidenceDirectory(
  directory: string,
  expectedReceipt?: string,
  expectedAcceptance?: string,
) {
  return verifyDirectoryWithTools(
    {
      readFile,
      lstat,
      realpath,
      resolve,
      sep,
      canonicalJson,
      createReceipt,
      evidenceHash,
      verifyEvidenceManifest,
    },
    directory,
    expectedReceipt,
    expectedAcceptance,
  );
}

/** Ship the exact same verifier logic in the package, with only Node built-ins. */
export function offlineVerifierSource() {
  return `#!/usr/bin/env node
import { readFile, lstat, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
const evidenceHash = bytes => createHash('sha256').update(bytes).digest('hex');
// tsx preserves function names with this no-op helper during local development.
const __name = (value) => value;
${canonicalJson.toString()}
${hashEvidenceRecord.toString()}
${createReceipt.toString()}
${verifyEvidenceManifest.toString()}
${verifyDirectoryWithTools.toString()}
const verifyEvidenceDirectory = (directory, receipt, acceptance) => verifyDirectoryWithTools({ readFile, lstat, realpath, resolve, sep, canonicalJson, createReceipt, evidenceHash, verifyEvidenceManifest }, directory, receipt, acceptance);
const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); if (index < 0) return undefined; if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error('Missing value for ' + name); return args[index + 1]; };
try {
  const result = await verifyEvidenceDirectory(args[0] && !args[0].startsWith('--') ? args[0] : '.', option('--receipt'), option('--acceptance'));
  console.log('All ' + result.filesVerified + ' files, consent records and document bindings passed. Outcome: ' + result.outcome + '.');
  console.log('Receipt fingerprint: ' + result.receipt.manifestSha256);
  console.log(result.anchorScope === 'complete-record' ? 'The supplied independent receipt fingerprint matches the complete record.' : result.anchorScope === 'acceptance-only' ? 'The supplied acceptance fingerprint matches that acceptance; it does not anchor the later final PDF.' : 'No independent fingerprint supplied. These checks establish internal consistency only, not signer identity, operator authenticity or trusted time.');
} catch (error) { console.error('Verification FAILED: ' + error.message); process.exitCode = 1; }
`;
}
