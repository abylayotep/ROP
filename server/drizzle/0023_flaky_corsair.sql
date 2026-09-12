CREATE TABLE "crm_analyses" (
	"conversation_id" uuid PRIMARY KEY NOT NULL,
	"source_version" timestamp with time zone,
	"analyzed_message_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"summary" text,
	"profile" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"confidence" integer,
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"analyzed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kaspi_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"request_key" text NOT NULL,
	"method" text NOT NULL,
	"phone" text NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"operation_id" text,
	"qr_token" text,
	"payment_url" text,
	"status" text DEFAULT 'creating' NOT NULL,
	"error" text,
	"confirmed_at" timestamp with time zone,
	"checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kaspi_payments_order_id_unique" UNIQUE("order_id"),
	CONSTRAINT "kaspi_payments_agent_request_key" UNIQUE("agent_id","request_key"),
	CONSTRAINT "kaspi_payments_agent_operation_key" UNIQUE("agent_id","operation_id")
);
--> statement-breakpoint
CREATE TABLE "kaspi_sessions" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"credentials" text,
	"organization" text,
	"phone" text,
	"process_id" text,
	"process_expires_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "messages_conversation_sent_at_idx";--> statement-breakpoint
ALTER TABLE "crm_analyses" ADD CONSTRAINT "crm_analyses_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kaspi_payments" ADD CONSTRAINT "kaspi_payments_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kaspi_payments" ADD CONSTRAINT "kaspi_payments_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kaspi_payments" ADD CONSTRAINT "kaspi_payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kaspi_sessions" ADD CONSTRAINT "kaspi_sessions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "kaspi_payments_one_open_conversation" ON "kaspi_payments" USING btree ("conversation_id") WHERE "kaspi_payments"."status" in ('creating', 'unknown', 'pending');--> statement-breakpoint
CREATE INDEX "kaspi_payments_status_checked_idx" ON "kaspi_payments" USING btree ("status","checked_at");--> statement-breakpoint
CREATE INDEX "ai_replies_message_idx" ON "ai_replies" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "messages_conversation_created_at_idx" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_conversation_sent_at_idx" ON "messages" USING btree ("conversation_id","sent_at","id");