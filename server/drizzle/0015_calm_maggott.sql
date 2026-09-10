CREATE TABLE "kb_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"title" text NOT NULL,
	"origin" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"ops" jsonb NOT NULL,
	"base" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "test_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"title" text NOT NULL,
	"messages" jsonb NOT NULL,
	"expectation" text,
	"origin" text DEFAULT 'manual' NOT NULL,
	"conversation_id" uuid,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "test_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"reply" text,
	"used_chunk_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"stage_id" uuid,
	"handoff" boolean DEFAULT false NOT NULL,
	"handoff_reason" text,
	"outcome" text NOT NULL,
	"cost" numeric(12, 8) DEFAULT '0' NOT NULL,
	"verdict" text,
	"verdict_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "test_results_run_case_key" UNIQUE("run_id","case_id")
);
--> statement-breakpoint
CREATE TABLE "test_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"draft_id" uuid,
	"config_version" integer NOT NULL,
	"model" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"cost" numeric(12, 8) DEFAULT '0' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "config_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "coach_messages" ADD COLUMN "draft_id" uuid;--> statement-breakpoint
ALTER TABLE "kb_drafts" ADD CONSTRAINT "kb_drafts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_drafts" ADD CONSTRAINT "kb_drafts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_cases" ADD CONSTRAINT "test_cases_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_cases" ADD CONSTRAINT "test_cases_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_results" ADD CONSTRAINT "test_results_run_id_test_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."test_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_results" ADD CONSTRAINT "test_results_case_id_test_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."test_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_runs" ADD CONSTRAINT "test_runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_runs" ADD CONSTRAINT "test_runs_draft_id_kb_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."kb_drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "kb_drafts_agent_status_idx" ON "kb_drafts" USING btree ("agent_id","status","created_at");--> statement-breakpoint
CREATE INDEX "test_cases_agent_enabled_idx" ON "test_cases" USING btree ("agent_id","enabled");--> statement-breakpoint
CREATE INDEX "test_runs_agent_draft_idx" ON "test_runs" USING btree ("agent_id","draft_id","started_at");--> statement-breakpoint
CREATE INDEX "test_runs_baseline_idx" ON "test_runs" USING btree ("agent_id","config_version");--> statement-breakpoint
ALTER TABLE "coach_messages" ADD CONSTRAINT "coach_messages_draft_id_kb_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."kb_drafts"("id") ON DELETE set null ON UPDATE no action;