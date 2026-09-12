-- Migrations 0025 and 0027 were finalized after some long-lived installations had already
-- recorded their original hashes. These guards are no-ops on fresh databases and repair
-- only the columns those installations missed.
ALTER TABLE "crm_analyses" ADD COLUMN IF NOT EXISTS "pending_live_message_id" uuid;--> statement-breakpoint
ALTER TABLE "crm_analyses" ADD COLUMN IF NOT EXISTS "handled_live_message_id" uuid;--> statement-breakpoint
ALTER TABLE "crm_analyses" ADD COLUMN IF NOT EXISTS "field_evidence" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "kaspi_payments" ADD COLUMN IF NOT EXISTS "notification_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "kaspi_payments" ADD COLUMN IF NOT EXISTS "notification_message_id" text;--> statement-breakpoint
ALTER TABLE "kaspi_payments" ADD COLUMN IF NOT EXISTS "notification_claimed_at" timestamp with time zone;
