ALTER TABLE "crm_analyses" ADD COLUMN "pending_live_message_id" uuid;--> statement-breakpoint
ALTER TABLE "crm_analyses" ADD COLUMN "handled_live_message_id" uuid;--> statement-breakpoint
ALTER TABLE "crm_analyses" ADD COLUMN "field_evidence" jsonb DEFAULT '{}'::jsonb NOT NULL;