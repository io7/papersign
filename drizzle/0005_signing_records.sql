CREATE TABLE "evidence_record" (
	"id" text PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"kind" text NOT NULL,
	"actor" text NOT NULL,
	"revision" integer NOT NULL,
	"body" jsonb NOT NULL,
	"files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"previous_hash" text,
	"hash" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "evidence_sequence_positive" CHECK ("evidence_record"."sequence" > 0),
	CONSTRAINT "evidence_kind_valid" CHECK ("evidence_record"."kind" in ('review', 'acceptance', 'finalization'))
);
--> statement-breakpoint
CREATE TABLE "service_heartbeat" (
	"name" text PRIMARY KEY NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signer_verification" (
	"id" text PRIMARY KEY NOT NULL,
	"invitation_id" text NOT NULL,
	"document_id" text NOT NULL,
	"purpose" text NOT NULL,
	"revision" integer NOT NULL,
	"email" text NOT NULL,
	"secret_hash" text NOT NULL,
	"code_hash" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"verified_at" timestamp with time zone,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "two_factor" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"failed_verification_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN "deletion_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "document_export" ADD COLUMN "canonical" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "document_export" ADD COLUMN "source_files" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "mfa_verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "two_factor_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "evidence_record" ADD CONSTRAINT "evidence_record_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "two_factor" ADD CONSTRAINT "two_factor_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_document_sequence_idx" ON "evidence_record" USING btree ("document_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_document_event_idx" ON "evidence_record" USING btree ("document_id","kind","actor","revision");--> statement-breakpoint
CREATE INDEX "signer_verification_invitation_idx" ON "signer_verification" USING btree ("invitation_id","sent_at");--> statement-breakpoint
CREATE INDEX "two_factor_user_idx" ON "two_factor" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "export_canonical_document_idx" ON "document_export" USING btree ("document_id") WHERE "document_export"."canonical" = true;