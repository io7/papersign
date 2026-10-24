import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "./db.js";
import { config } from "./config.js";
import { documents, exportsTable, invitations, user, audit } from "./schema.js";
import { evidenceRecords, evidenceTimestamps } from "./evidence-schema.js";
import { loadFile, sha256, storeFile } from "./storage.js";
import {
  canonicalJson,
  createReceipt,
  hashEvidenceRecord,
  verifyEvidenceManifest,
} from "./evidence-core.js";
import { assertExportBudget, assertStorageBudget } from "./storage-usage.js";
import type {
  EvidenceBody,
  EvidenceFile,
  EvidenceManifest,
  EvidenceRecord,
  EvidenceStoredFile,
} from "../shared/evidence.js";
import type { FrozenPlacement } from "../shared/types.js";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Reader = Pick<typeof db, "select" | "query">;
type Row = typeof evidenceRecords.$inferSelect;
const integrityError = () =>
  Object.assign(
    new Error(
      "Stored signing evidence failed its integrity check. Contact the PaperSign operator.",
    ),
    { statusCode: 409, publicError: true },
  );
const publicFile = ({
  fileKey: _key,
  ...file
}: EvidenceStoredFile): EvidenceFile => file;
export function portableEvidenceRecord(row: Row): EvidenceRecord {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    files: row.files.map(publicFile),
  };
}

export async function verifiedEvidenceFile(
  fileKey: string,
  expectedSha256: string,
) {
  const bytes = await loadFile(fileKey);
  if (
    !/^[a-f0-9]{64}$/.test(expectedSha256) ||
    sha256(bytes) !== expectedSha256
  )
    throw integrityError();
  return bytes;
}

async function appendEvidence(
  tx: Transaction,
  input: {
    documentId: string;
    actor: string;
    revision: number;
    kind: EvidenceRecord["kind"];
    body: EvidenceBody;
    files: EvidenceStoredFile[];
  },
) {
  await tx.execute(
    sql`select id from document where id = ${input.documentId} for update`,
  );
  const [previous] = await tx
    .select()
    .from(evidenceRecords)
    .where(eq(evidenceRecords.documentId, input.documentId))
    .orderBy(desc(evidenceRecords.sequence))
    .limit(1);
  if (previous?.kind === "finalization")
    throw new Error("A finalized evidence record cannot be extended.");
  const createdAt = new Date();
  const content = {
    id: randomUUID(),
    documentId: input.documentId,
    actor: input.actor,
    revision: input.revision,
    kind: input.kind,
    sequence: (previous?.sequence ?? 0) + 1,
    previousHash: previous?.hash ?? null,
    body: input.body,
    files: input.files.map(publicFile),
    createdAt: createdAt.toISOString(),
  };
  const [record] = await tx
    .insert(evidenceRecords)
    .values({
      ...content,
      files: input.files,
      createdAt,
      hash: hashEvidenceRecord(content),
    })
    .returning();
  return record;
}

export async function retainReview(
  tx: Transaction,
  input: {
    documentId: string;
    actor: string;
    revision: number;
    bytes: Buffer;
  },
) {
  await tx.execute(
    sql`select id from document where id = ${input.documentId} for update`,
  );
  const [existing] = await tx
    .select()
    .from(evidenceRecords)
    .where(
      and(
        eq(evidenceRecords.documentId, input.documentId),
        eq(evidenceRecords.actor, input.actor),
        eq(evidenceRecords.revision, input.revision),
        eq(evidenceRecords.kind, "review"),
      ),
    )
    .limit(1);
  if (existing) {
    const file = existing.files[0];
    if (
      !file ||
      hashEvidenceRecord(
        (({ hash: _hash, ...rest }) => rest)(portableEvidenceRecord(existing)),
      ) !== existing.hash
    )
      throw integrityError();
    await verifiedEvidenceFile(file.fileKey, file.sha256);
    return { id: existing.id, sha256: file.sha256, fileKey: file.fileKey };
  }
  const [document] = await tx
    .select({ userId: documents.userId })
    .from(documents)
    .where(eq(documents.id, input.documentId));
  if (!document) throw new Error("Document not found.");
  await tx.execute(
    sql`select id from "user" where id = ${document.userId} for update`,
  );
  await assertStorageBudget(document.userId, input.bytes.length, tx);
  const fileKey = await storeFile(input.bytes, "pdf");
  const digest = sha256(input.bytes);
  const record = await appendEvidence(tx, {
    documentId: input.documentId,
    actor: input.actor,
    revision: input.revision,
    kind: "review",
    body: { pdfSha256: digest },
    files: [
      {
        fileKey,
        name: `reviews/${sha256(input.actor).slice(0, 24)}-${input.revision}.pdf`,
        sha256: digest,
        size: input.bytes.length,
      },
    ],
  });
  return { id: record.id, sha256: digest, fileKey };
}

export async function recordAcceptance(
  tx: Transaction,
  input: {
    documentId: string;
    actor: string;
    revision: number;
    reviewId: string;
    authentication: {
      method: string;
      email: string;
      verifiedAt?: string;
      checkedAt?: string;
      [key: string]: unknown;
    };
    statedName: string;
    consent: { version: string; text: string };
    signature: { fileKey: string; bytes: Buffer };
    fields: Record<string, unknown>;
    additionalSignatures?: Array<{ fileKey: string; bytes: Buffer }>;
  },
) {
  const [review] = await tx
    .select()
    .from(evidenceRecords)
    .where(
      and(
        eq(evidenceRecords.id, input.reviewId),
        eq(evidenceRecords.documentId, input.documentId),
        eq(evidenceRecords.actor, input.actor),
        eq(evidenceRecords.revision, input.revision),
        eq(evidenceRecords.kind, "review"),
      ),
    )
    .limit(1);
  if (!review)
    throw Object.assign(
      new Error("Open and review this version of the PDF before signing."),
      { statusCode: 409, publicError: true },
    );
  const reviewed = portableEvidenceRecord(review);
  const { hash, ...content } = reviewed;
  if (hashEvidenceRecord(content) !== hash || !review.files[0])
    throw integrityError();
  await verifiedEvidenceFile(review.files[0].fileKey, review.files[0].sha256);
  const signatureHash = sha256(input.signature.bytes);
  await verifiedEvidenceFile(input.signature.fileKey, signatureHash);
  const retainedSignatures: EvidenceStoredFile[] = [
    {
      name: `signatures/${sha256(input.actor).slice(0, 24)}.png`,
      fileKey: input.signature.fileKey,
      sha256: signatureHash,
      size: input.signature.bytes.length,
    },
  ];
  for (const [index, signature] of (
    input.additionalSignatures ?? []
  ).entries()) {
    const digest = sha256(signature.bytes);
    await verifiedEvidenceFile(signature.fileKey, digest);
    retainedSignatures.push({
      name: `signatures/${sha256(input.actor).slice(0, 24)}-${index + 1}.png`,
      fileKey: signature.fileKey,
      sha256: digest,
      size: signature.bytes.length,
    });
  }
  const record = await appendEvidence(tx, {
    documentId: input.documentId,
    actor: input.actor,
    revision: input.revision,
    kind: "acceptance",
    body: {
      reviewId: review.id,
      reviewedPdfSha256: review.files[0].sha256,
      authentication: input.authentication,
      statedName: input.statedName,
      consent: input.consent,
      signatureSha256: signatureHash,
      fields: input.fields,
    },
    files: retainedSignatures,
  });
  return { id: record.id, hash: record.hash };
}

export async function ensureCanonicalExport(
  tx: Transaction,
  input: {
    documentId: string;
    revision: number;
    originalKey: string;
    layers: FrozenPlacement[];
  },
) {
  await tx.execute(
    sql`select id from document where id = ${input.documentId} for update`,
  );
  const [existing] = await tx
    .select()
    .from(exportsTable)
    .where(
      and(
        eq(exportsTable.documentId, input.documentId),
        eq(exportsTable.canonical, true),
      ),
    )
    .limit(1);
  if (existing) return existing;
  const [document] = await tx
    .select({ userId: documents.userId, placements: documents.placements })
    .from(documents)
    .where(eq(documents.id, input.documentId));
  if (!document) throw new Error("Document not found.");
  await tx.execute(
    sql`select id from "user" where id = ${document.userId} for update`,
  );
  await assertExportBudget(document.userId, tx);
  const accepted = await tx
    .select({ actor: evidenceRecords.actor })
    .from(evidenceRecords)
    .where(
      and(
        eq(evidenceRecords.documentId, input.documentId),
        eq(evidenceRecords.kind, "acceptance"),
      ),
    );
  const signed = await tx
    .select({ id: invitations.id })
    .from(invitations)
    .where(
      and(
        eq(invitations.documentId, input.documentId),
        eq(invitations.state, "signed"),
      ),
    );
  const actors = new Set(accepted.map((record) => record.actor));
  const evidenceComplete =
    actors.size > 0 &&
    signed.every((person) => actors.has(person.id)) &&
    (!document.placements.some((placement) => placement.kind !== "text") ||
      actors.has(`owner:${document.userId}`));
  const keys = [
    ...new Set([
      input.originalKey,
      ...input.layers
        .filter((layer) => layer.kind !== "text")
        .map((layer) => layer.imageKey),
    ]),
  ];
  const sourceFiles: EvidenceStoredFile[] = [];
  for (const [index, fileKey] of keys.entries()) {
    const bytes = await loadFile(fileKey);
    sourceFiles.push({
      name: `render-source-${index}`,
      fileKey,
      sha256: sha256(bytes),
      size: bytes.length,
    });
  }
  const [record] = await tx
    .insert(exportsTable)
    .values({
      id: randomUUID(),
      documentId: input.documentId,
      revision: input.revision,
      rasterize: false,
      canonical: true,
      evidenceComplete,
      sealPolicyId: config.SEAL_POLICY_ID ?? "",
      originalKey: input.originalKey,
      layers: input.layers,
      sourceFiles,
    })
    .returning();
  return record;
}

export async function recordFinalization(
  tx: Transaction,
  record: typeof exportsTable.$inferSelect,
  file: { fileKey: string; bytes: Buffer },
) {
  if (!record.canonical || record.rasterize)
    throw new Error(
      "Only the canonical ordinary PDF can finalize signing evidence.",
    );
  const acceptances = await tx
    .select()
    .from(evidenceRecords)
    .where(
      and(
        eq(evidenceRecords.documentId, record.documentId),
        eq(evidenceRecords.kind, "acceptance"),
      ),
    )
    .orderBy(asc(evidenceRecords.sequence));
  if (!acceptances.length && !record.evidenceComplete) return null;
  if (!acceptances.length)
    throw new Error("There is no preserved acceptance for this document.");
  return appendEvidence(tx, {
    documentId: record.documentId,
    actor: "system:pdf-worker",
    revision: record.revision,
    kind: "finalization",
    body: {
      exportId: record.id,
      pdfSha256: sha256(file.bytes),
      sealPolicyId: record.sealPolicyId,
      acceptanceHashes: acceptances.map((acceptance) => acceptance.hash),
    },
    files: [
      {
        fileKey: file.fileKey,
        name: "final.pdf",
        sha256: sha256(file.bytes),
        size: file.bytes.length,
      },
    ],
  });
}

export async function getCompletedRecord(
  documentId: string,
  reader: Reader = db,
) {
  const [record] = await reader
    .select()
    .from(exportsTable)
    .where(
      and(
        eq(exportsTable.documentId, documentId),
        eq(exportsTable.canonical, true),
      ),
    )
    .limit(1);
  if (!record || record.state !== "ready" || !record.fileKey || !record.sha256)
    throw Object.assign(
      new Error(
        record?.state === "failed"
          ? "The completed record could not be prepared. Ask the document owner to retry."
          : "The completed record is still being prepared.",
      ),
      { statusCode: 409, publicError: true },
    );
  return record;
}

export async function evidenceTimestampStatus(
  documentId: string,
  reader: Reader = db,
) {
  const [record] = await reader
    .select()
    .from(evidenceTimestamps)
    .where(eq(evidenceTimestamps.documentId, documentId))
    .limit(1);
  if (record)
    return {
      state: "available" as const,
      sha256: record.sha256,
      manifestSha256: record.manifestSha256,
      createdAt: record.createdAt.toISOString(),
    };
  const [failure] = await reader
    .select({ createdAt: audit.createdAt })
    .from(audit)
    .where(
      and(
        eq(audit.documentId, documentId),
        eq(audit.event, "evidence_timestamp_failed"),
      ),
    )
    .orderBy(desc(audit.createdAt))
    .limit(1);
  if (failure)
    return {
      state: "failed" as const,
      createdAt: failure.createdAt.toISOString(),
    };
  const [request] = await reader
    .select({ id: audit.id })
    .from(audit)
    .where(
      and(
        eq(audit.documentId, documentId),
        eq(audit.event, "evidence_timestamp_requested"),
      ),
    )
    .limit(1);
  return { state: request ? ("pending" as const) : ("not-requested" as const) };
}

export async function completedEvidence(
  documentId: string,
  reader: Reader = db,
  options: { verifyStoredFiles?: boolean } = {},
) {
  const [document] = await reader
    .select()
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1);
  if (!document) throw new Error("Document not found.");
  const [owner] = await reader
    .select({ email: user.email })
    .from(user)
    .where(eq(user.id, document.userId))
    .limit(1);
  if (!owner) throw new Error("Document owner not found.");
  const final = await getCompletedRecord(documentId, reader);
  if (!final.evidenceComplete)
    throw Object.assign(
      new Error(
        "This document includes earlier signatures without a complete preserved acceptance record. The final PDF is available, but a complete signing receipt and evidence package cannot be reconstructed.",
      ),
      { statusCode: 409, publicError: true },
    );
  const rows = await reader
    .select()
    .from(evidenceRecords)
    .where(eq(evidenceRecords.documentId, documentId))
    .orderBy(asc(evidenceRecords.sequence));
  const participants = await reader
    .select()
    .from(invitations)
    .where(eq(invitations.documentId, documentId))
    .orderBy(asc(invitations.signingOrder));
  const source = await verifiedEvidenceFile(
    document.fileKey,
    document.sourceHash,
  );
  const originalPdf = {
    name: "original.pdf",
    sha256: document.sourceHash,
    size: source.length,
  };
  const files: EvidenceStoredFile[] = [
    { ...originalPdf, fileKey: document.fileKey },
    ...rows.flatMap((row) => row.files),
  ];
  const finalPdf = files.find((file) => file.name === "final.pdf");
  if (
    !finalPdf ||
    finalPdf.sha256 !== final.sha256 ||
    finalPdf.fileKey !== final.fileKey
  )
    throw integrityError();
  const manifest: EvidenceManifest = {
    format: "papersign-evidence-v1",
    document: {
      id: document.id,
      name: document.name,
      sourceHash: document.sourceHash,
      ownerId: document.userId,
      ownerEmail: owner.email,
      status: document.status,
    },
    originalPdf,
    finalPdf: publicFile(finalPdf),
    outcome:
      document.status === "cancelled"
        ? "cancelled"
        : !participants.length
          ? "owner-signed"
          : participants.some((participant) => participant.state === "revoked")
            ? "completed-with-revocations"
            : "all-signed",
    participants: participants.map((participant) => ({
      id: participant.id,
      name: participant.name,
      email: participant.email,
      order: participant.signingOrder,
      state: participant.state,
    })),
    records: rows.map(portableEvidenceRecord),
    files: files.map(publicFile),
  };
  verifyEvidenceManifest(manifest);
  if (options.verifyStoredFiles) {
    const checked = new Set<string>();
    for (const file of files) {
      if (checked.has(file.fileKey)) continue;
      await verifiedEvidenceFile(file.fileKey, file.sha256);
      checked.add(file.fileKey);
    }
  }
  return {
    manifest,
    receipt: createReceipt(manifest),
    files,
    manifestBytes: Buffer.from(canonicalJson(manifest) + "\n"),
    timestamp: await evidenceTimestampStatus(documentId, reader),
  };
}
