ALTER TABLE "capi_events" ADD COLUMN "last_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "capi_events" ADD COLUMN "fbtrace_id" text;