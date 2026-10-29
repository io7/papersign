ALTER TABLE "signer_verification" ADD COLUMN "method" text DEFAULT 'email-one-time-code' NOT NULL;--> statement-breakpoint
ALTER TABLE "signer_verification" ADD COLUMN "factor" text;--> statement-breakpoint
ALTER TABLE "signer_verification" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "signer_verification" ADD COLUMN "totp_step" bigint;--> statement-breakpoint
ALTER TABLE "signer_verification" ADD CONSTRAINT "signer_verification_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "signer_verification_user_idx" ON "signer_verification" USING btree ("user_id","sent_at");--> statement-breakpoint
CREATE UNIQUE INDEX "signer_verification_totp_once" ON "signer_verification" USING btree ("user_id","totp_step") WHERE "signer_verification"."totp_step" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "signer_verification" ADD CONSTRAINT "signer_verification_method_valid" CHECK (("signer_verification"."method" = 'email-one-time-code' AND "signer_verification"."factor" IS NULL) OR ("signer_verification"."method" = 'account-authenticator' AND "signer_verification"."factor" IN ('code', 'session') AND "signer_verification"."user_id" IS NOT NULL));