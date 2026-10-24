CREATE TABLE "account_invitation" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"role" text DEFAULT 'user' NOT NULL,
	"token_hash" text NOT NULL,
	"sealed_token" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"created_by" text NOT NULL,
	"accepted_by" text,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_invitation_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "account_invitation_role_valid" CHECK ("account_invitation"."role" IN ('admin', 'user')),
	CONSTRAINT "account_invitation_state_valid" CHECK ("account_invitation"."state" IN ('pending', 'accepted', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "admin_event" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_id" text NOT NULL,
	"event" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "role" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "account_invitation" ADD CONSTRAINT "account_invitation_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_invitation" ADD CONSTRAINT "account_invitation_accepted_by_user_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_event" ADD CONSTRAINT "admin_event_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_invitation_email_idx" ON "account_invitation" USING btree ("email");--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_role_valid" CHECK ("user"."role" IN ('admin', 'user'));