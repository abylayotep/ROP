CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"phone" text NOT NULL,
	"name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contacts_agent_phone_key" UNIQUE("agent_id","phone")
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"whatsapp_number_id" uuid NOT NULL,
	"last_inbound_at" timestamp with time zone,
	"last_message_at" timestamp with time zone,
	"ctwa_clid" text,
	"ad_source_id" text,
	"ad_source_type" text,
	"ad_headline" text,
	"ad_body" text,
	"referral_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_number_contact_key" UNIQUE("whatsapp_number_id","contact_id")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"wa_message_id" text NOT NULL,
	"direction" text NOT NULL,
	"author" text NOT NULL,
	"kind" text NOT NULL,
	"body" text,
	"media_path" text,
	"media_mime" text,
	"status" text,
	"sent_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_wa_message_id_unique" UNIQUE("wa_message_id")
);
--> statement-breakpoint
CREATE TABLE "whatsapp_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "whatsapp_numbers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"phone_number_id" text NOT NULL,
	"waba_id" text NOT NULL,
	"display_phone" text NOT NULL,
	"access_token" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"subscribed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "whatsapp_numbers_phone_number_id_unique" UNIQUE("phone_number_id")
);
--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_whatsapp_number_id_whatsapp_numbers_id_fk" FOREIGN KEY ("whatsapp_number_id") REFERENCES "public"."whatsapp_numbers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_numbers" ADD CONSTRAINT "whatsapp_numbers_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversations_agent_last_message_idx" ON "conversations" USING btree ("agent_id","last_message_at");--> statement-breakpoint
CREATE INDEX "messages_conversation_sent_at_idx" ON "messages" USING btree ("conversation_id","sent_at");--> statement-breakpoint
CREATE INDEX "whatsapp_events_processed_at_idx" ON "whatsapp_events" USING btree ("processed_at");--> statement-breakpoint
CREATE INDEX "whatsapp_numbers_agent_id_idx" ON "whatsapp_numbers" USING btree ("agent_id");