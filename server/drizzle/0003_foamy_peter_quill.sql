ALTER TABLE "messages" ALTER COLUMN "wa_message_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "whatsapp_events" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;