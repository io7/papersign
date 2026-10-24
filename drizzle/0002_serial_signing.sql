ALTER TABLE "invitation" ADD COLUMN "signing_order" integer;--> statement-breakpoint
-- Preserve accepted signatures and bearer links. Historical parallel signers who
-- already completed keep their signatures first; outstanding links acquire a
-- deterministic serial order, including rows with the same creation timestamp.
WITH ordered AS (
  SELECT "id", row_number() OVER (
    PARTITION BY "document_id"
    ORDER BY
      CASE WHEN "state" = 'signed' THEN 0 ELSE 1 END,
      CASE WHEN "state" = 'signed' THEN "signed_at" END NULLS LAST,
      "created_at", "id"
  )::integer AS "position"
  FROM "invitation"
)
UPDATE "invitation" AS invitation
SET "signing_order" = ordered."position"
FROM ordered WHERE invitation."id" = ordered."id";--> statement-breakpoint
ALTER TABLE "invitation" ALTER COLUMN "signing_order" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "invitation_document_order_idx" ON "invitation" USING btree ("document_id","signing_order");--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_signing_order_positive" CHECK ("invitation"."signing_order" > 0);
