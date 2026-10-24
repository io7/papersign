CREATE TABLE "document_evidence_timestamp" (
	"document_id" text PRIMARY KEY NOT NULL,
	"manifest_sha256" text NOT NULL,
	"file_key" text NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document_evidence_timestamp" ADD CONSTRAINT "document_evidence_timestamp_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE no action ON UPDATE no action;