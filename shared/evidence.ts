/** Evidence proves internal consistency. Origin requires a separately retained receipt or trust anchor. */
export const EVIDENCE_FORMAT = "papersign-evidence-v1" as const;
export interface EvidenceFile {
  name: string;
  sha256: string;
  size: number;
}
export interface EvidenceStoredFile extends EvidenceFile {
  fileKey: string;
}
export type EvidenceBody = Record<string, unknown>;
export interface EvidenceRecord {
  id: string;
  documentId: string;
  sequence: number;
  kind: "review" | "acceptance" | "finalization";
  actor: string;
  revision: number;
  createdAt: string;
  previousHash: string | null;
  body: EvidenceBody;
  files: EvidenceFile[];
  hash: string;
}
export interface EvidenceManifest {
  format: typeof EVIDENCE_FORMAT;
  document: {
    id: string;
    name: string;
    sourceHash: string;
    ownerId: string;
    ownerEmail: string;
    status: string;
  };
  finalPdf: EvidenceFile;
  originalPdf: EvidenceFile;
  outcome:
    "all-signed" | "completed-with-revocations" | "owner-signed" | "cancelled";
  participants: Array<{
    id: string;
    name: string;
    email: string;
    order: number;
    state: string;
  }>;
  records: EvidenceRecord[];
  files: EvidenceFile[];
}
export interface EvidenceReceipt {
  format: "papersign-receipt-v1";
  documentId: string;
  manifestSha256: string;
  finalPdfSha256: string;
  ledgerHead: string;
}
