ALTER TABLE "kaspi_payments" ADD COLUMN "notification_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "kaspi_payments" ADD COLUMN "notification_message_id" text;--> statement-breakpoint
ALTER TABLE "kaspi_payments" ADD COLUMN "notification_claimed_at" timestamp with time zone;