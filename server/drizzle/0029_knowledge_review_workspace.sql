ALTER TABLE "agents" ADD COLUMN "communication_style" text DEFAULT 'warm' NOT NULL;--> statement-breakpoint
ALTER TABLE "kb_generation_batches" ADD COLUMN "classification" text;--> statement-breakpoint
ALTER TABLE "kb_generation_batches" ADD COLUMN "classification_reason" text;--> statement-breakpoint
ALTER TABLE "kb_generation_proposals" ADD COLUMN "kind" text DEFAULT 'knowledge' NOT NULL;--> statement-breakpoint
ALTER TABLE "kb_generation_proposals" ADD COLUMN "confidence" text DEFAULT 'review' NOT NULL;--> statement-breakpoint
ALTER TABLE "kb_generation_proposals" ADD COLUMN "selected" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE TABLE "kb_generation_drafts" (
	"run_id" uuid NOT NULL,
	"draft_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kb_generation_drafts_run_draft" UNIQUE("run_id","draft_id")
);
--> statement-breakpoint
ALTER TABLE "kb_generation_drafts" ADD CONSTRAINT "kb_generation_drafts_run_id_kb_generation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."kb_generation_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_generation_drafts" ADD CONSTRAINT "kb_generation_drafts_draft_id_kb_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."kb_drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "kb_generation_drafts_draft_idx" ON "kb_generation_drafts" USING btree ("draft_id");
