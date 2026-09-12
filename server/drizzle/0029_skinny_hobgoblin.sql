CREATE TABLE "agent_response_mode_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"old_response_mode" text NOT NULL,
	"old_test_contact_id" uuid,
	"new_response_mode" text NOT NULL,
	"new_test_contact_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_response_mode_changes_old_mode_check" CHECK ("agent_response_mode_changes"."old_response_mode" in ('off', 'test', 'live')),
	CONSTRAINT "agent_response_mode_changes_new_mode_check" CHECK ("agent_response_mode_changes"."new_response_mode" in ('off', 'test', 'live'))
);
--> statement-breakpoint
ALTER TABLE "agent_response_mode_changes" ADD CONSTRAINT "agent_response_mode_changes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_response_mode_changes_agent_created_idx" ON "agent_response_mode_changes" USING btree ("agent_id","created_at");
