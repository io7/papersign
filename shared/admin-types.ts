export type UserRole = "admin" | "user";
export interface CurrentUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  emailVerified?: boolean;
  twoFactorEnabled?: boolean;
  mfaVerified?: boolean;
}
export interface AdminSummary {
  users: number;
  admins: number;
  documents: number;
  documentsAwaiting: number;
  documentsCompleted: number;
  storedSignatures: number;
  uploadedBytes: number;
  pendingAccountInvitations: number;
}
export interface PageResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
export interface AdminUser extends CurrentUser {
  createdAt: string;
  documentCount: number;
  signatureCount: number;
}
export interface AdminDocument {
  id: string;
  name: string;
  owner: { id: string; name: string; email: string };
  status: string;
  byteSize: number;
  pageCount: number;
  createdAt: string;
  updatedAt: string;
}
export interface AccountInvitation {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  state: "pending" | "accepted" | "revoked" | "expired";
  expiresAt: string;
  createdAt: string;
  acceptedAt: string | null;
  url: string | null;
}
export interface AccountInvitationPreview {
  name: string;
  email: string;
  role: UserRole;
  expiresAt: string;
}
export interface InvitationEmailPreview {
  to: string;
  subject: string;
  body: string;
  html?: string;
  attachments: never[];
  previewHash: string;
  enabled: boolean;
}
export interface AdminApiKey {
  id: string;
  name: string;
  prefix: string;
  owner: { id: string; name: string; email: string };
  state: "active" | "expired" | "revoked";
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}
export interface CreatedApiKey {
  key: AdminApiKey;
  secret: string;
}
