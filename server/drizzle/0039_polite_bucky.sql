ALTER TABLE "ai_sandbox_sessions" ADD COLUMN "crm_summary" text;--> statement-breakpoint
ALTER TABLE "ai_sandbox_sessions" ADD COLUMN "crm_profile" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_sandbox_turns" ADD COLUMN "effect_source" text DEFAULT 'ai' NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_sandbox_turns" ADD COLUMN "checkout" jsonb;