CREATE TABLE "kb_generation_raw_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"path" text NOT NULL,
	"body" text NOT NULL,
	"warnings" text[] DEFAULT '{}'::text[] NOT NULL,
	"sources" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kb_generation_raw_findings" ADD CONSTRAINT "kb_generation_raw_findings_run_id_kb_generation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."kb_generation_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_generation_raw_findings" ADD CONSTRAINT "kb_generation_raw_findings_batch_id_kb_generation_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."kb_generation_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "kb_generation_raw_findings_run_created_idx" ON "kb_generation_raw_findings" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX "kb_generation_raw_findings_run_fingerprint_idx" ON "kb_generation_raw_findings" USING btree ("run_id","fingerprint");