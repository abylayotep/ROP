ALTER TABLE "agents" ADD CONSTRAINT "agents_account_id_id_key" UNIQUE("account_id","id");--> statement-breakpoint
CREATE TABLE "ai_sandbox_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"phone" text,
	"revision" integer DEFAULT 0 NOT NULL,
	"stage_id" uuid,
	"stage_name" text,
	"fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"outcome" text,
	"handoff" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_sandbox_sessions_scope_id_key" UNIQUE("account_id","agent_id","id"),
	CONSTRAINT "ai_sandbox_sessions_revision_check" CHECK ("ai_sandbox_sessions"."revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "ai_sandbox_turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"user_text" text NOT NULL,
	"reply" text,
	"config_version" integer NOT NULL,
	"model" text NOT NULL,
	"source_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"stage_id" uuid,
	"stage_name" text,
	"fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"handoff" text,
	"outcome" text NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_sandbox_turns_session_revision_key" UNIQUE("session_id","revision"),
	CONSTRAINT "ai_sandbox_turns_revision_check" CHECK ("ai_sandbox_turns"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "ai_sandbox_sessions" ADD CONSTRAINT "ai_sandbox_sessions_account_agent_fk" FOREIGN KEY ("account_id","agent_id") REFERENCES "public"."agents"("account_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_sandbox_turns" ADD CONSTRAINT "ai_sandbox_turns_session_scope_fk" FOREIGN KEY ("account_id","agent_id","session_id") REFERENCES "public"."ai_sandbox_sessions"("account_id","agent_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_sandbox_sessions_agent_updated_idx" ON "ai_sandbox_sessions" USING btree ("agent_id","updated_at");--> statement-breakpoint
CREATE INDEX "ai_sandbox_turns_session_revision_idx" ON "ai_sandbox_turns" USING btree ("session_id","revision");
