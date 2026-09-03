-- The moment the funnel starts.
--
-- `conversations` has always kept the last stage a lead was put in and nothing else, so no
-- record exists of any move made before this file runs. `stage_transitions` begins recording
-- them, one append-only row per move, and `agents.stage_history_since` records per agent when
-- that began: the column is added `NOT NULL DEFAULT now()`, which stamps every agent that
-- already exists — including the one this product is actually running on — with the instant
-- this migration ran. The statistics screen names that date, so an owner reads the funnel as
-- «since then» instead of assuming it covers the whole history of their business.
--
-- Nothing backfills `stage_transitions`, and that is a decision rather than a deferral. The
-- only available source is one synthetic row per conversation from `stage_id` / `stage_set_at`,
-- and a lead that moved five times would contribute a single entry, landing entirely on the
-- stage it stands in today. Every earlier stage would then show fewer entries than the one
-- after it, and the conversion between them would print above 100% — a visibly impossible
-- number, in the one place an owner is deciding about money.
-- See docs/superpowers/specs/2026-09-03-statistics-design.md.
CREATE TABLE "stage_transitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"from_stage_id" uuid,
	"to_stage_id" uuid,
	"from_name" text,
	"to_name" text NOT NULL,
	"to_kind" text NOT NULL,
	"from_position" integer,
	"to_position" integer NOT NULL,
	"moved_by" text NOT NULL,
	"moved_by_user_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "stage_history_since" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "stage_transitions" ADD CONSTRAINT "stage_transitions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_transitions" ADD CONSTRAINT "stage_transitions_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_transitions" ADD CONSTRAINT "stage_transitions_from_stage_id_stages_id_fk" FOREIGN KEY ("from_stage_id") REFERENCES "public"."stages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_transitions" ADD CONSTRAINT "stage_transitions_to_stage_id_stages_id_fk" FOREIGN KEY ("to_stage_id") REFERENCES "public"."stages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_transitions" ADD CONSTRAINT "stage_transitions_moved_by_user_id_users_id_fk" FOREIGN KEY ("moved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stage_transitions_agent_occurred_idx" ON "stage_transitions" USING btree ("agent_id","occurred_at");--> statement-breakpoint
CREATE INDEX "stage_transitions_conversation_idx" ON "stage_transitions" USING btree ("conversation_id","occurred_at");