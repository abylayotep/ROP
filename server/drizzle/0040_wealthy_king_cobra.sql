CREATE TABLE "response_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"conversation_id" uuid,
	"ai_reply_id" uuid,
	"session_id" uuid,
	"sandbox_turn_id" uuid,
	"correction_type" text NOT NULL,
	"note" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "response_feedback_one_source_check" CHECK (("response_feedback"."conversation_id" is not null and "response_feedback"."ai_reply_id" is not null and "response_feedback"."session_id" is null and "response_feedback"."sandbox_turn_id" is null) or ("response_feedback"."conversation_id" is null and "response_feedback"."ai_reply_id" is null and "response_feedback"."session_id" is not null and "response_feedback"."sandbox_turn_id" is not null)),
	CONSTRAINT "response_feedback_type_check" CHECK ("response_feedback"."correction_type" in ('fact', 'behavior')),
	CONSTRAINT "response_feedback_revision_check" CHECK ("response_feedback"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "coach_messages" ADD COLUMN "feedback_id" uuid;--> statement-breakpoint
ALTER TABLE "coach_messages" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "coach_messages" ADD COLUMN "source_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "ai_replies" ADD CONSTRAINT "ai_replies_agent_conversation_id_key" UNIQUE("agent_id","conversation_id","id");--> statement-breakpoint
ALTER TABLE "ai_sandbox_turns" ADD CONSTRAINT "ai_sandbox_turns_scope_id_key" UNIQUE("account_id","agent_id","session_id","id");--> statement-breakpoint
ALTER TABLE "response_feedback" ADD CONSTRAINT "response_feedback_agent_scope_fk" FOREIGN KEY ("account_id","agent_id") REFERENCES "public"."agents"("account_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "response_feedback" ADD CONSTRAINT "response_feedback_live_scope_fk" FOREIGN KEY ("agent_id","conversation_id","ai_reply_id") REFERENCES "public"."ai_replies"("agent_id","conversation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "response_feedback" ADD CONSTRAINT "response_feedback_sandbox_scope_fk" FOREIGN KEY ("account_id","agent_id","session_id","sandbox_turn_id") REFERENCES "public"."ai_sandbox_turns"("account_id","agent_id","session_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "response_feedback_agent_created_idx" ON "response_feedback" USING btree ("agent_id","created_at");--> statement-breakpoint
ALTER TABLE "coach_messages" ADD CONSTRAINT "coach_messages_feedback_id_response_feedback_id_fk" FOREIGN KEY ("feedback_id") REFERENCES "public"."response_feedback"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE FUNCTION response_feedback_immutable_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.account_id, OLD.agent_id, OLD.conversation_id, OLD.ai_reply_id, OLD.session_id, OLD.sandbox_turn_id, OLD.correction_type, OLD.note, OLD.snapshot, OLD.created_at)
    IS DISTINCT FROM
    (NEW.account_id, NEW.agent_id, NEW.conversation_id, NEW.ai_reply_id, NEW.session_id, NEW.sandbox_turn_id, NEW.correction_type, NEW.note, NEW.snapshot, NEW.created_at) THEN
    RAISE EXCEPTION 'Response feedback evidence is immutable';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER response_feedback_immutable_evidence_trigger BEFORE UPDATE ON response_feedback
FOR EACH ROW EXECUTE FUNCTION response_feedback_immutable_evidence();
