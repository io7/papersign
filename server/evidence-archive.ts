import { Readable } from "node:stream";
import { completedEvidence, verifiedEvidenceFile } from "./evidence.js";
import { canonicalJson } from "./evidence-core.js";
import { offlineVerifierSource } from "./evidence-verifier.js";
import type { EvidenceManifest, EvidenceReceipt } from "../shared/evidence.js";
import { eq } from "drizzle-orm";
import { db } from "./db.js";
import { evidenceTimestamps } from "./evidence-schema.js";
import type { ManifestTimestamp } from "./evidence-timestamp-core.js";

export function evidenceReport(
  manifest: EvidenceManifest,
  receipt: EvidenceReceipt,
) {
  const lines = [
    "PaperSign signing record",
    "",
    manifest.document.name,
    `Document: ${manifest.document.id}`,
    `Outcome: ${manifest.outcome}`,
    `Final PDF SHA-256: ${manifest.finalPdf.sha256}`,
    `Receipt fingerprint: ${receipt.manifestSha256}`,
    "",
    "Retain this receipt separately from PaperSign and this package.",
    "Extract this TAR package, then run with Node.js 24 or newer:",
    "  node verify.mjs . --receipt <your separately retained fingerprint>",
    "An acceptance fingerprint saved when signing can also be checked:",
    "  node verify.mjs . --acceptance <your acceptance fingerprint>",
    "",
    "An acceptance fingerprint anchors that person's review and acceptance only.",
    "Retain the final receipt fingerprint to anchor the whole completed record.",
    "",
    "The checks detect changes relative to those fingerprints. A hash chain alone",
    "does not prove the operator's identity, legal authority, or trusted time.",
    "Recorded times come from the PaperSign server unless a certificate seal reports otherwise.",
    "Email verification establishes mailbox control, not legal identity or company authority.",
    "",
    "If timestamp.json is present, verify.mjs does NOT validate its cryptographic signature.",
    "Cryptographic timestamp validation uses PaperSign's separate Node verifier and a TSA",
    "root certificate obtained independently of this package:",
    "  node --import tsx scripts/verify-evidence-timestamp.ts <this-directory> <trusted-root.pem>",
    "That check validates retained certificate/CRL evidence at the signed timestamp time.",
    "It does not check today's revocation status or provide archival timestamp renewal.",
    "",
  ];
  for (const record of manifest.records.filter(
    (record) => record.kind === "acceptance",
  )) {
    const consent = record.body.consent as { version: string; text: string };
    const auth = record.body.authentication as {
      method: string;
      email: string;
      verifiedAt?: string;
      checkedAt?: string;
    };
    lines.push(
      `Accepted by: ${record.body.statedName}`,
      `Email: ${auth.email}`,
      `Authentication: ${auth.method}`,
      auth.method === "verified-account"
        ? `Verified account email status checked at: ${auth.checkedAt}`
        : `Mailbox code verified at: ${auth.verifiedAt}`,
      `Accepted at: ${record.createdAt}`,
      `Reviewed revision: ${record.revision}`,
      `Reviewed PDF SHA-256: ${record.body.reviewedPdfSha256}`,
      `Consent ${consent.version}: ${consent.text}`,
      `Acceptance fingerprint: ${record.hash}`,
      "",
    );
  }
  for (const person of manifest.participants.filter(
    (person) => person.state === "revoked",
  ))
    lines.push(`Did not sign (revoked): ${person.name} <${person.email}>`);
  return lines.join("\n") + "\n";
}

/** Minimal POSIX ustar writer: fixed safe names, ordinary files, no compression/dependencies. */
export function tarHeader(name: string, size: number) {
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(name) ||
    name.includes("..") ||
    Buffer.byteLength(name) > 99 ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    size > 8_589_934_591
  )
    throw new Error("Invalid archive member.");
  const header = Buffer.alloc(512);
  const octal = (offset: number, width: number, value: number) =>
    header.write(
      value.toString(8).padStart(width - 1, "0") + "\0",
      offset,
      width,
      "ascii",
    );
  header.write(name, 0, 100, "utf8");
  octal(100, 8, 0o600);
  octal(108, 8, 0);
  octal(116, 8, 0);
  octal(124, 12, size);
  octal(136, 12, 0);
  header.fill(0x20, 148, 156);
  header.write("0", 156);
  header.write("ustar\0", 257);
  header.write("00", 263);
  const checksum = header.reduce((sum, value) => sum + value, 0);
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return header;
}

export async function buildEvidenceArchive(documentId: string) {
  const evidence = await completedEvidence(documentId);
  // Fail before response headers if any immutable file has been corrupted.
  for (const file of evidence.files)
    await verifiedEvidenceFile(file.fileKey, file.sha256);
  const metadata = [
    { name: "manifest.json", bytes: evidence.manifestBytes },
    {
      name: "receipt.json",
      bytes: Buffer.from(canonicalJson(evidence.receipt) + "\n"),
    },
    {
      name: "report.txt",
      bytes: Buffer.from(evidenceReport(evidence.manifest, evidence.receipt)),
    },
    { name: "verify.mjs", bytes: Buffer.from(offlineVerifierSource()) },
  ];
  const [timestampRow] = await db
    .select()
    .from(evidenceTimestamps)
    .where(eq(evidenceTimestamps.documentId, documentId))
    .limit(1);
  if (timestampRow) {
    if (timestampRow.manifestSha256 !== evidence.receipt.manifestSha256)
      throw new Error("Timestamp belongs to a different evidence manifest.");
    const timestampBytes = await verifiedEvidenceFile(
      timestampRow.fileKey,
      timestampRow.sha256,
    );
    const timestamp = JSON.parse(
      timestampBytes.toString("utf8"),
    ) as ManifestTimestamp;
    metadata.push({ name: "timestamp.json", bytes: timestampBytes });
    for (const [name, value] of [
      ["timestamp/request.tsq", timestamp.request],
      ["timestamp/response.tsr", timestamp.response],
      ["timestamp/token.der", timestamp.token],
    ] as const)
      metadata.push({ name, bytes: Buffer.from(value, "base64") });
    timestamp.certificates.forEach((value, index) =>
      metadata.push({
        name: `timestamp/certificate-${index}.der`,
        bytes: Buffer.from(value, "base64"),
      }),
    );
    timestamp.crls.forEach((value, index) =>
      metadata.push({
        name: `timestamp/revocation-${index}.crl`,
        bytes: Buffer.from(value, "base64"),
      }),
    );
  }
  async function* archive() {
    for (const file of metadata) {
      yield tarHeader(file.name, file.bytes.length);
      yield file.bytes;
      if (file.bytes.length % 512)
        yield Buffer.alloc(512 - (file.bytes.length % 512));
    }
    for (const file of evidence.files) {
      const bytes = await verifiedEvidenceFile(file.fileKey, file.sha256);
      yield tarHeader(file.name, bytes.length);
      yield bytes;
      if (bytes.length % 512) yield Buffer.alloc(512 - (bytes.length % 512));
    }
    yield Buffer.alloc(1024);
  }
  return { stream: Readable.from(archive()), receipt: evidence.receipt };
}
