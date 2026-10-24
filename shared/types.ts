export interface PageInfo {
  width: number;
  height: number;
  rotation: number;
}
export interface SigningField {
  id: string;
  pageIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface SignaturePlacement extends SigningField {
  kind?: "signature";
  signatureId: string;
}
export interface TextPlacement extends SigningField {
  kind: "text";
  text: string;
  fontSize: number;
}
export type Placement = SignaturePlacement | TextPlacement;
export interface FrozenSignaturePlacement extends SigningField {
  kind?: "signature";
  imageKey: string;
}
export type FrozenPlacement = FrozenSignaturePlacement | TextPlacement;
export interface RecipientTextField extends SigningField {
  label: string;
  fontSize: number;
}
export interface RecipientTextValue {
  id: string;
  text: string;
}
// The existing JSON field stores additions without rewriting old invitations.
export interface StoredSigningField extends SigningField {
  textFields?: RecipientTextField[];
  textValues?: RecipientTextValue[];
}
export interface Signature {
  id: string;
  name: string;
  source: "drawn" | "uploaded";
  width: number;
  height: number;
  isDefault: boolean;
  createdAt: string;
}
export type SigningStatus =
  "ready" | "waiting" | "signed" | "revoked" | "expired";
export interface Invitation {
  id: string;
  name: string;
  email: string;
  state: string;
  signingOrder: number;
  signingStatus: SigningStatus;
  canSign: boolean;
  expiresAt: string;
  signedAt: string | null;
  field: SigningField;
  textFields?: RecipientTextField[];
  url?: string;
}
export interface SigningRequest {
  name: string;
  documentName: string;
  pages: PageInfo[];
  field: SigningField;
  textFields?: RecipientTextField[];
  state: string;
  completed: boolean;
  signingOrder: number;
  totalSigners: number;
  waitingForSigners: number;
  canSign: boolean;
  signingStatus: SigningStatus;
  revision: number;
}
export interface DocumentInfo {
  id: string;
  name: string;
  byteSize: number;
  pages: PageInfo[];
  placements: Placement[];
  status: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  invitations?: Invitation[];
}
export interface ExportInfo {
  id: string;
  state: string;
  rasterize: boolean;
  error: string | null;
  sealPolicyId?: string;
  seal?: CertificateSeal | null;
}
export interface CertificateSeal {
  profile: "PAdES-B-LT";
  signerFingerprint: string;
  timestamp: string;
  tsaFingerprint: string;
  validationCertificates: number;
  validationCrls: number;
}
