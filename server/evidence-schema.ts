import {
  pgTable,
  text,
  integer,
  jsonb,
  timestamp,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { documents } from "./schema.js";
import type {
  EvidenceBody,
  EvidenceStoredFile,
  EvidenceRecord,
} from "../shared/evidence.js";

export const evidenceRecords = pgTable(
  "evidence_record",
  {
    id: text("id").primaryKey(),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id),
    sequence: integer("sequence").notNull(),
    kind: text("kind").$type<EvidenceRecord["kind"]>().notNull(),
    actor: text("actor").notNull(),
    revision: integer("revision").notNull(),
    body: jsonb("body").$type<EvidenceBody>().notNull(),
    files: jsonb("files").$type<EvidenceStoredFile[]>().notNull().default([]),
    previousHash: text("previous_hash"),
    hash: text("hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("evidence_document_sequence_idx").on(t.documentId, t.sequence),
    uniqueIndex("evidence_document_event_idx").on(
      t.documentId,
      t.kind,
      t.actor,
      t.revision,
    ),
    check("evidence_sequence_positive", sql`${t.sequence} > 0`),
    check(
      "evidence_kind_valid",
      sql`${t.kind} in ('review', 'acceptance', 'finalization')`,
    ),
  ],
);

export const evidenceTimestamps = pgTable("document_evidence_timestamp", {
  documentId: text("document_id")
    .primaryKey()
    .references(() => documents.id),
  manifestSha256: text("manifest_sha256").notNull(),
  fileKey: text("file_key").notNull(),
  sha256: text("sha256").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
