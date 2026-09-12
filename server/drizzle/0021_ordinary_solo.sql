CREATE TABLE "kb_generation_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"manifest" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"cost" numeric(12, 8) DEFAULT '0' NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kb_generation_batches_run_ordinal" UNIQUE("run_id","ordinal")
);
--> statement-breakpoint
CREATE TABLE "kb_generation_previews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"user_id" uuid,
	"selection" jsonb NOT NULL,
	"manifest" jsonb NOT NULL,
	"counts" jsonb NOT NULL,
	"model_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_generation_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"path" text NOT NULL,
	"body" text NOT NULL,
	"warnings" text[] DEFAULT '{}'::text[] NOT NULL,
	"sources" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"draft_id" uuid,
	"draft_op_index" integer,
	"note_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kb_generation_proposals_run_fingerprint" UNIQUE("run_id","fingerprint")
);
--> statement-breakpoint
CREATE TABLE "kb_generation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"user_id" uuid,
	"requested_preview_id" uuid NOT NULL,
	"request_key" text NOT NULL,
	"selection" jsonb NOT NULL,
	"manifest" jsonb NOT NULL,
	"counts" jsonb NOT NULL,
	"model_id" text NOT NULL,
	"temperature" numeric(3, 2) NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"cancel_requested_at" timestamp with time zone,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"cost" numeric(12, 8) DEFAULT '0' NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kb_generation_runs_agent_request_key" UNIQUE("agent_id","request_key")
);
--> statement-breakpoint
ALTER TABLE "kb_generation_batches" ADD CONSTRAINT "kb_generation_batches_run_id_kb_generation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."kb_generation_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_generation_previews" ADD CONSTRAINT "kb_generation_previews_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_generation_previews" ADD CONSTRAINT "kb_generation_previews_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_generation_proposals" ADD CONSTRAINT "kb_generation_proposals_run_id_kb_generation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."kb_generation_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_generation_proposals" ADD CONSTRAINT "kb_generation_proposals_batch_id_kb_generation_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."kb_generation_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_generation_proposals" ADD CONSTRAINT "kb_generation_proposals_draft_id_kb_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."kb_drafts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_generation_proposals" ADD CONSTRAINT "kb_generation_proposals_note_id_kb_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."kb_notes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_generation_runs" ADD CONSTRAINT "kb_generation_runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_generation_runs" ADD CONSTRAINT "kb_generation_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "kb_generation_previews_agent_expires_idx" ON "kb_generation_previews" USING btree ("agent_id","expires_at");--> statement-breakpoint
CREATE INDEX "kb_generation_proposals_run_status_idx" ON "kb_generation_proposals" USING btree ("run_id","status","created_at");--> statement-breakpoint
CREATE INDEX "kb_generation_proposals_draft_idx" ON "kb_generation_proposals" USING btree ("draft_id");--> statement-breakpoint
CREATE INDEX "kb_generation_proposals_note_idx" ON "kb_generation_proposals" USING btree ("note_id");--> statement-breakpoint
CREATE UNIQUE INDEX "kb_generation_runs_one_active_per_agent" ON "kb_generation_runs" USING btree ("agent_id") WHERE "kb_generation_runs"."status" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "kb_generation_runs_agent_created_idx" ON "kb_generation_runs" USING btree ("agent_id","created_at");