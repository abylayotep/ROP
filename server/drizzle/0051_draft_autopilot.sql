CREATE TABLE "draft_autopilots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"draft_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"status" text NOT NULL,
	"step" text NOT NULL,
	"case_ids" uuid[] DEFAULT '{}' NOT NULL,
	"run_id" uuid,
	"run_ops" jsonb,
	"runs_started" integer DEFAULT 0 NOT NULL,
	"run_failures" integer DEFAULT 0 NOT NULL,
	"noise_retry_used" boolean DEFAULT false NOT NULL,
	"topic_attempts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"pending_fixes" jsonb,
	"log" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cost" numeric(12, 8) DEFAULT '0' NOT NULL,
	"stop_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "test_results" ADD COLUMN "used_op_indexes" integer[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "draft_autopilots" ADD CONSTRAINT "draft_autopilots_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_autopilots" ADD CONSTRAINT "draft_autopilots_draft_id_kb_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."kb_drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_autopilots" ADD CONSTRAINT "draft_autopilots_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_autopilots" ADD CONSTRAINT "draft_autopilots_run_id_test_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."test_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "draft_autopilots_one_running" ON "draft_autopilots" USING btree ("draft_id") WHERE "draft_autopilots"."status" = 'running';--> statement-breakpoint
CREATE INDEX "draft_autopilots_running" ON "draft_autopilots" USING btree ("status") WHERE "draft_autopilots"."status" = 'running';