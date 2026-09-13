CREATE TABLE "instagram_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"instagram_user_id" text NOT NULL,
	"page_id" text NOT NULL,
	"username" text,
	"access_token" text NOT NULL,
	"token_expires_at" timestamp with time zone,
	"enabled" boolean DEFAULT true NOT NULL,
	"subscribed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instagram_accounts_instagram_user_id_key" UNIQUE("instagram_user_id"),
	CONSTRAINT "instagram_accounts_id_agent_key" UNIQUE("id","agent_id")
);
--> statement-breakpoint
CREATE TABLE "instagram_contacts" (
	"contact_id" uuid PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"instagram_account_id" uuid NOT NULL,
	"instagram_user_id" text NOT NULL,
	"username" text,
	CONSTRAINT "instagram_contacts_account_user_key" UNIQUE("instagram_account_id","instagram_user_id")
);
--> statement-breakpoint
CREATE TABLE "instagram_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"processing_at" timestamp with time zone,
	"conversation_ids" jsonb
);
--> statement-breakpoint
ALTER TABLE "contacts" DROP CONSTRAINT "contacts_agent_phone_key";--> statement-breakpoint
ALTER TABLE "conversations" DROP CONSTRAINT "conversations_number_contact_key";--> statement-breakpoint
ALTER TABLE "contacts" ALTER COLUMN "phone" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "whatsapp_number_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "instagram_account_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "instagram_message_id" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_id_agent_key" UNIQUE("id","agent_id");--> statement-breakpoint
ALTER TABLE "instagram_accounts" ADD CONSTRAINT "instagram_accounts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instagram_contacts" ADD CONSTRAINT "instagram_contacts_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instagram_contacts" ADD CONSTRAINT "instagram_contacts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instagram_contacts" ADD CONSTRAINT "instagram_contacts_contact_agent_fk" FOREIGN KEY ("contact_id","agent_id") REFERENCES "public"."contacts"("id","agent_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instagram_contacts" ADD CONSTRAINT "instagram_contacts_account_agent_fk" FOREIGN KEY ("instagram_account_id","agent_id") REFERENCES "public"."instagram_accounts"("id","agent_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "instagram_accounts_agent_id_idx" ON "instagram_accounts" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "instagram_events_processed_at_idx" ON "instagram_events" USING btree ("processed_at");--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_instagram_account_id_instagram_accounts_id_fk" FOREIGN KEY ("instagram_account_id") REFERENCES "public"."instagram_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_contact_agent_fk" FOREIGN KEY ("contact_id","agent_id") REFERENCES "public"."contacts"("id","agent_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_instagram_account_agent_fk" FOREIGN KEY ("instagram_account_id","agent_id") REFERENCES "public"."instagram_accounts"("id","agent_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_agent_phone_key" ON "contacts" USING btree ("agent_id","phone");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_number_contact_key" ON "conversations" USING btree ("whatsapp_number_id","contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_instagram_contact_key" ON "conversations" USING btree ("instagram_account_id","contact_id") WHERE "conversations"."instagram_account_id" is not null;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_instagram_message_id_unique" UNIQUE("instagram_message_id");--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_one_provider_check" CHECK (num_nonnulls("conversations"."whatsapp_number_id", "conversations"."instagram_account_id") = 1);
