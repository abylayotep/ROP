ALTER TABLE "agents" ADD COLUMN "crm_analysis_mode" text DEFAULT 'follow_ai' NOT NULL;
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_crm_analysis_mode_check" CHECK ("crm_analysis_mode" IN ('follow_ai', 'independent'));
