ALTER TABLE "whatsapp_numbers" ADD COLUMN "connection_kind" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "whatsapp_numbers" ADD COLUMN "business_id" text;--> statement-breakpoint
ALTER TABLE "whatsapp_numbers" ADD COLUMN "sync_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "whatsapp_numbers" ADD COLUMN "sync_error" text;--> statement-breakpoint
ALTER TABLE "whatsapp_numbers" ADD COLUMN "history_progress" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "whatsapp_numbers" ADD COLUMN "history_declined_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "whatsapp_numbers" ADD COLUMN "offboarded_at" timestamp with time zone;