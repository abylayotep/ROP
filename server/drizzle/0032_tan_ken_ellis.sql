ALTER TABLE "instagram_contacts" DROP CONSTRAINT "instagram_contacts_agent_user_key";--> statement-breakpoint
ALTER TABLE "instagram_contacts" ADD COLUMN "instagram_account_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "instagram_events" ADD COLUMN "processing_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "instagram_events" ADD COLUMN "conversation_ids" jsonb;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_id_agent_key" UNIQUE("id","agent_id");--> statement-breakpoint
ALTER TABLE "instagram_accounts" ADD CONSTRAINT "instagram_accounts_id_agent_key" UNIQUE("id","agent_id");--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_contact_agent_fk" FOREIGN KEY ("contact_id","agent_id") REFERENCES "public"."contacts"("id","agent_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_instagram_account_agent_fk" FOREIGN KEY ("instagram_account_id","agent_id") REFERENCES "public"."instagram_accounts"("id","agent_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instagram_contacts" ADD CONSTRAINT "instagram_contacts_contact_agent_fk" FOREIGN KEY ("contact_id","agent_id") REFERENCES "public"."contacts"("id","agent_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instagram_contacts" ADD CONSTRAINT "instagram_contacts_account_agent_fk" FOREIGN KEY ("instagram_account_id","agent_id") REFERENCES "public"."instagram_accounts"("id","agent_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instagram_contacts" ADD CONSTRAINT "instagram_contacts_account_user_key" UNIQUE("instagram_account_id","instagram_user_id");
