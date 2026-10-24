import {
  pgTable,
  text,
  timestamp,
  integer,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { documents, invitations } from "./schema.js";

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
  },
  (t) => [
    index("signer_verification_invitation_idx").on(t.invitationId, t.sentAt),
    check(
      "signer_verification_purpose_valid",
      sql`${t.purpose} IN ('sign', 'record')`,
    ),
    check("signer_verification_revision_positive", sql`${t.revision} > 0`),
    check("signer_verification_attempts_positive", sql`${t.attempts} >= 0`),
  ],
);
