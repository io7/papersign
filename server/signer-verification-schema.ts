import {
  pgTable,
  text,
  timestamp,
  integer,
  bigint,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { documents, invitations, user } from "./schema.js";

const time = (name: string) => timestamp(name, { withTimezone: true });

export const signerVerifications = pgTable(
  "signer_verification",
  {
    id: text("id").primaryKey(),
    invitationId: text("invitation_id")
      .notNull()
      .references(() => invitations.id, { onDelete: "cascade" }),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    purpose: text("purpose").notNull(),
    revision: integer("revision").notNull(),
    email: text("email").notNull(),
    secretHash: text("secret_hash").notNull(),
    codeHash: text("code_hash"),
    attempts: integer("attempts").notNull().default(0),
    sentAt: time("sent_at").notNull().defaultNow(),
    deliveredAt: time("delivered_at"),
    expiresAt: time("expires_at").notNull(),
    verifiedAt: time("verified_at"),
    consumedAt: time("consumed_at"),
    // How the signer proved who they are. Account proofs name the PaperSign
    // account whose verified email matched the invitation.
    method: text("method").notNull().default("email-one-time-code"),
    factor: text("factor"),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    // The authenticator time step a code matched. Unique per account, so one
    // code can never be accepted twice.
    totpStep: bigint("totp_step", { mode: "number" }),
  },
  (t) => [
    index("signer_verification_invitation_idx").on(t.invitationId, t.sentAt),
    index("signer_verification_user_idx").on(t.userId, t.sentAt),
    uniqueIndex("signer_verification_totp_once")
      .on(t.userId, t.totpStep)
      .where(sql`${t.totpStep} IS NOT NULL`),
    check(
      "signer_verification_purpose_valid",
      sql`${t.purpose} IN ('sign', 'record')`,
    ),
    check(
      "signer_verification_method_valid",
      sql`(${t.method} = 'email-one-time-code' AND ${t.factor} IS NULL) OR (${t.method} = 'account-authenticator' AND ${t.factor} IN ('code', 'session') AND ${t.userId} IS NOT NULL)`,
    ),
    check("signer_verification_revision_positive", sql`${t.revision} > 0`),
    check("signer_verification_attempts_positive", sql`${t.attempts} >= 0`),
  ],
);
