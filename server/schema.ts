import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { EvidenceStoredFile } from "../shared/evidence.js";
import type {
  PageInfo,
  Placement,
  FrozenPlacement,
  StoredSigningField,
  CertificateSeal,
} from "../shared/types.js";
const time = (name: string) => timestamp(name, { withTimezone: true });
export const user = pgTable(
  "user",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    emailVerified: boolean("email_verified").notNull().default(false),
    twoFactorEnabled: boolean("two_factor_enabled").notNull().default(false),
    deletionRequestedAt: time("deletion_requested_at"),
    role: text("role").notNull().default("user"),
    image: text("image"),
    createdAt: time("created_at").notNull().defaultNow(),
    updatedAt: time("updated_at").notNull().defaultNow(),
  },
  (t) => [check("user_role_valid", sql`${t.role} IN ('admin', 'user')`)],
);
export const accountInvitations = pgTable(
  "account_invitation",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    role: text("role").notNull().default("user"),
    tokenHash: text("token_hash").notNull().unique(),
    sealedToken: text("sealed_token").notNull(),
    state: text("state").notNull().default("pending"),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id),
    acceptedBy: text("accepted_by").references(() => user.id),
    expiresAt: time("expires_at").notNull(),
    acceptedAt: time("accepted_at"),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("account_invitation_email_idx").on(t.email),
    check("account_invitation_role_valid", sql`${t.role} IN ('admin', 'user')`),
    check(
      "account_invitation_state_valid",
      sql`${t.state} IN ('pending', 'accepted', 'revoked')`,
    ),
  ],
);
export const adminEvents = pgTable("admin_event", {
  id: text("id").primaryKey(),
  actorId: text("actor_id")
    .notNull()
    .references(() => user.id),
  event: text("event").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull(),
  details: jsonb("details").notNull().default({}),
  createdAt: time("created_at").notNull().defaultNow(),
});
// A key always acts as the Admin who created it. Only the SHA-256 hash of the
// secret is stored; the prefix identifies the key in lists and audit events.
export const apiKeys = pgTable(
  "api_key",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id),
    prefix: text("prefix").notNull(),
    keyHash: text("key_hash").notNull().unique(),
    expiresAt: time("expires_at").notNull(),
    lastUsedAt: time("last_used_at"),
    revokedAt: time("revoked_at"),
    revokedBy: text("revoked_by").references(() => user.id),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (t) => [index("api_key_user_idx").on(t.userId)],
);
export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull().unique(),
    expiresAt: time("expires_at").notNull(),
    createdAt: time("created_at").notNull().defaultNow(),
    updatedAt: time("updated_at").notNull().defaultNow(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    mfaVerified: boolean("mfa_verified").notNull().default(false),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [index("session_user_idx").on(t.userId)],
);
export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: time("access_token_expires_at"),
    refreshTokenExpiresAt: time("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: time("created_at").notNull().defaultNow(),
    updatedAt: time("updated_at").notNull().defaultNow(),
  },
  (t) => [index("account_user_idx").on(t.userId)],
);
export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: time("expires_at").notNull(),
  createdAt: time("created_at").notNull().defaultNow(),
  updatedAt: time("updated_at").notNull().defaultNow(),
});
export const signatures = pgTable(
  "signature",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id),
    name: text("name").notNull(),
    source: text("source").notNull(),
    fileKey: text("file_key").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: time("created_at").notNull().defaultNow(),
    deletedAt: time("deleted_at"),
  },
  (t) => [
    index("signature_owner_idx").on(t.userId),
    uniqueIndex("signature_default_idx")
      .on(t.userId)
      .where(sql`${t.isDefault} = true AND ${t.deletedAt} IS NULL`),
  ],
);
export const documents = pgTable(
  "document",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id),
    name: text("name").notNull(),
    fileKey: text("file_key").notNull(),
    sourceHash: text("source_hash").notNull(),
    byteSize: integer("byte_size").notNull(),
    pages: jsonb("pages").$type<PageInfo[]>().notNull(),
    placements: jsonb("placements").$type<Placement[]>().notNull().default([]),
    status: text("status").notNull().default("draft"),
    revision: integer("revision").notNull().default(1),
    previewKey: text("preview_key"),
    deletedAt: time("deleted_at"),
    deletionRequestedAt: time("deletion_requested_at"),
    createdAt: time("created_at").notNull().defaultNow(),
    updatedAt: time("updated_at").notNull().defaultNow(),
  },
  (t) => [index("document_owner_idx").on(t.userId)],
);
export const invitations = pgTable(
  "invitation",
  {
    id: text("id").primaryKey(),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id),
    name: text("name").notNull(),
    email: text("email").notNull(),
    signingOrder: integer("signing_order").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    // Encrypted at rest: the owner can copy a link later without storing a bearer token in plaintext.
    sealedToken: text("sealed_token").notNull(),
    field: jsonb("field").$type<StoredSigningField>().notNull(),
    state: text("state").notNull().default("pending"),
    expiresAt: time("expires_at").notNull(),
    signedAt: time("signed_at"),
    signedName: text("signed_name"),
    imageKey: text("image_key"),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("invitation_document_idx").on(t.documentId),
    uniqueIndex("invitation_document_order_idx").on(
      t.documentId,
      t.signingOrder,
    ),
    check("invitation_signing_order_positive", sql`${t.signingOrder} > 0`),
  ],
);
export const exportsTable = pgTable(
  "document_export",
  {
    id: text("id").primaryKey(),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id),
    revision: integer("revision").notNull(),
    rasterize: boolean("rasterize").notNull(),
    canonical: boolean("canonical").notNull().default(false),
    evidenceComplete: boolean("evidence_complete").notNull().default(true),
    sourceFiles: jsonb("source_files")
      .$type<EvidenceStoredFile[]>()
      .notNull()
      .default([]),
    sealPolicyId: text("seal_policy_id").notNull().default(""),
    seal: jsonb("seal").$type<CertificateSeal>(),
    originalKey: text("original_key").notNull(),
    layers: jsonb("layers").$type<FrozenPlacement[]>().notNull(),
    state: text("state").notNull().default("queued"),
    fileKey: text("file_key"),
    sha256: text("sha256"),
    error: text("error"),
    startedAt: time("started_at"),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("export_document_idx").on(t.documentId),
    uniqueIndex("export_canonical_document_idx")
      .on(t.documentId)
      .where(sql`${t.canonical} = true`),
  ],
);
export const audit = pgTable("audit_event", {
  id: text("id").primaryKey(),
  documentId: text("document_id")
    .notNull()
    .references(() => documents.id),
  actor: text("actor").notNull(),
  event: text("event").notNull(),
  details: jsonb("details").notNull().default({}),
  createdAt: time("created_at").notNull().defaultNow(),
});
export const serviceHeartbeats = pgTable("service_heartbeat", {
  name: text("name").primaryKey(),
  updatedAt: time("updated_at").notNull().defaultNow(),
});
export { evidenceRecords, evidenceTimestamps } from "./evidence-schema.js";
export { signerVerifications } from "./signer-verification-schema.js";
export { twoFactor } from "./account-security-schema.js";
