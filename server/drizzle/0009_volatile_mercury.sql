CREATE TABLE "capi_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"conversation_id" uuid,
	"order_id" uuid,
	"kind" text NOT NULL,
	"event_id" text NOT NULL,
	"payload" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capi_events_event_id_unique" UNIQUE("event_id")
);
--> statement-breakpoint
CREATE TABLE "capi_settings" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"dataset_id" text NOT NULL,
	"access_token" text NOT NULL,
	"test_event_code" text,
	"enabled" boolean DEFAULT false NOT NULL,
	"verified_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "capi_events" ADD CONSTRAINT "capi_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capi_events" ADD CONSTRAINT "capi_events_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capi_events" ADD CONSTRAINT "capi_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capi_settings" ADD CONSTRAINT "capi_settings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "capi_events_status_created_idx" ON "capi_events" USING btree ("status","created_at");