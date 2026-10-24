ALTER TABLE "document_export" ADD COLUMN "seal_policy_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "document_export" ADD COLUMN "seal" jsonb;