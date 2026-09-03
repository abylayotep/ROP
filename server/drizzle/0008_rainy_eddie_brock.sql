CREATE TABLE "ai_replies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"message_id" uuid,
	"model" text NOT NULL,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"cost" numeric(12, 8) DEFAULT '0' NOT NULL,
	"outcome" text NOT NULL,
	"detail" text,
	"used_item_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "ai_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "model" text DEFAULT 'openai/gpt-4o-mini' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "temperature" numeric(3, 2) DEFAULT '0.30' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "instructions" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "reply_language" text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "openrouter_key" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "ai_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_replies" ADD CONSTRAINT "ai_replies_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_replies" ADD CONSTRAINT "ai_replies_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_replies" ADD CONSTRAINT "ai_replies_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_replies_agent_created_idx" ON "ai_replies" USING btree ("agent_id","created_at");