ALTER TABLE "agents" ADD COLUMN "response_mode" text DEFAULT 'off' NOT NULL;--> statement-breakpoint
UPDATE "agents" SET "response_mode" = CASE WHEN "ai_enabled" THEN 'live' ELSE 'off' END;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "test_contact_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_test_contact_id_contacts_id_fk" FOREIGN KEY ("test_contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_response_mode_check" CHECK ("agents"."response_mode" in ('off', 'test', 'live'));
