import { createHash } from "node:crypto";
import type {
  EvidenceManifest,
  EvidenceRecord,
  EvidenceReceipt,
} from "../shared/evidence.js";

export const evidenceHash = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");

/** Deliberately small JSON profile, also reproduced in the offline verifier. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (
    typeof value === "object" &&
    value &&
    Object.getPrototypeOf(value) === Object.prototype
  )
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  throw new Error("Evidence contains unsupported JSON values.");
}

export function hashEvidenceRecord(record: Omit<EvidenceRecord, "hash">) {
  return evidenceHash(canonicalJson(record));
}

export function createReceipt(manifest: EvidenceManifest): EvidenceReceipt {
  return {
    format: "papersign-receipt-v1",
    documentId: manifest.document.id,
    manifestSha256: evidenceHash(canonicalJson(manifest)),
    finalPdfSha256: manifest.finalPdf.sha256,
    ledgerHead: manifest.records.at(-1)?.hash ?? "",
  };
}

export function verifyEvidenceManifest(manifest: EvidenceManifest) {
  if (manifest.format !== "papersign-evidence-v1" || !manifest.records.length)
    throw new Error("Unsupported or empty evidence manifest.");
  const files = new Map(manifest.files.map((file) => [file.name, file]));
  if (files.size !== manifest.files.length)
    throw new Error("Duplicate evidence filenames.");
  for (const file of manifest.files)
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(file.name) ||
      file.name.split("/").some((part) => part === ".." || !part) ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0
    )
      throw new Error("Invalid evidence file reference.");
  const sameFile = (file: { name: string; sha256: string; size: number }) =>
    canonicalJson(files.get(file.name)) === canonicalJson(file);
  if (
    !sameFile(manifest.originalPdf) ||
    manifest.originalPdf.sha256 !== manifest.document.sourceHash ||
    !sameFile(manifest.finalPdf)
  )
    throw new Error("Document file binding is invalid.");
  let previousHash: string | null = null;
  const byId = new Map<string, EvidenceRecord>();
  const accepted = new Set<string>();
  let finalizations = 0;
  for (let i = 0; i < manifest.records.length; i++) {
    const record = manifest.records[i];
    const { hash, ...hashed } = record;
    if (
      record.documentId !== manifest.document.id ||
      record.sequence !== i + 1 ||
      record.previousHash !== previousHash ||
      byId.has(record.id) ||
      hashEvidenceRecord(hashed) !== hash
    )
      throw new Error("The evidence chain was changed or reordered.");
    if (!record.files.every(sameFile))
      throw new Error(
        "An evidence record refers to a missing or changed file.",
      );
    if (record.kind === "review") {
      if (
        record.files.length !== 1 ||
        record.body.pdfSha256 !== record.files[0].sha256
      )
        throw new Error("Review PDF binding is invalid.");
    } else if (record.kind === "acceptance") {
      const review = byId.get(String(record.body.reviewId));
      if (
        !review ||
        review.kind !== "review" ||
        review.actor !== record.actor ||
        review.revision !== record.revision ||
        review.body.pdfSha256 !== record.body.reviewedPdfSha256 ||
        accepted.has(record.actor)
      )
        throw new Error(
          "Acceptance is not bound to its signer's reviewed PDF.",
        );
      const consent = record.body.consent as
        { version?: string; text?: string } | undefined;
      const authentication = record.body.authentication as
        | {
            method?: string;
            email?: string;
            verifiedAt?: string;
            checkedAt?: string;
          }
        | undefined;
      let authenticationTime: string | undefined;
      if (authentication?.method === "verified-account")
        authenticationTime = authentication.checkedAt;
      else if (
        authentication?.method === "email-one-time-code" ||
        authentication?.method === "account-authenticator"
      )
        authenticationTime = authentication.verifiedAt;
      if (
        !consent?.version ||
        !consent.text ||
        !authentication?.email ||
        !authenticationTime ||
        !Number.isFinite(Date.parse(authenticationTime)) ||
        !record.files.some(
          (file) => file.sha256 === record.body.signatureSha256,
        )
      )
        throw new Error(
          "Acceptance is missing consent, authentication or signature evidence.",
        );
      const participant = manifest.participants.find(
        (person) => person.id === record.actor,
      );
      const expectedEmail =
        record.actor === `owner:${manifest.document.ownerId}`
          ? manifest.document.ownerEmail
          : participant?.state === "signed"
            ? participant.email
            : undefined;
      if (
        !expectedEmail ||
        authentication.email.toLowerCase() !== expectedEmail.toLowerCase()
      )
        throw new Error(
          "Acceptance authentication does not match a document participant.",
        );
      accepted.add(record.actor);
    } else if (record.kind === "finalization") {
      finalizations++;
      if (
        i !== manifest.records.length - 1 ||
        record.body.pdfSha256 !== manifest.finalPdf.sha256 ||
        !record.files.some((file) => file.name === manifest.finalPdf.name) ||
        canonicalJson(record.body.acceptanceHashes) !==
          canonicalJson(
            manifest.records
              .filter((item) => item.kind === "acceptance")
              .map((item) => item.hash),
          )
      )
        throw new Error(
          "Final PDF is not bound to the completed acceptance chain.",
        );
    } else throw new Error("Unknown evidence event.");
    previousHash = hash;
    byId.set(record.id, record);
  }
  if (finalizations !== 1 || !accepted.size)
    throw new Error("The record has not been finalized with an acceptance.");
  const signed = manifest.participants.filter(
    (participant) => participant.state === "signed",
  );
  if (
    signed.some((participant) => !accepted.has(participant.id)) ||
    manifest.participants.some(
      (participant) => !["signed", "revoked"].includes(participant.state),
    )
  )
    throw new Error(
      "Participant completion does not match the recorded acceptances.",
    );
  if (!["completed", "cancelled"].includes(manifest.document.status))
    throw new Error("The document workflow has not finished.");
  const expectedOutcome =
    manifest.document.status === "cancelled"
      ? "cancelled"
      : manifest.participants.length === 0
        ? "owner-signed"
        : manifest.participants.some(
              (participant) => participant.state === "revoked",
            )
          ? "completed-with-revocations"
          : "all-signed";
  if (manifest.outcome !== expectedOutcome)
    throw new Error("The stated signing outcome is incorrect.");
  if (
    !manifest.participants.length &&
    !accepted.has(`owner:${manifest.document.ownerId}`)
  )
    throw new Error("Owner acceptance is missing.");
}
