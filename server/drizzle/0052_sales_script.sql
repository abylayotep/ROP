CREATE TABLE "sales_script_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"parent_id" uuid,
	"position" integer NOT NULL,
	"title" text NOT NULL,
	"condition" text DEFAULT '' NOT NULL,
	"instructions" text DEFAULT '' NOT NULL,
	"stage_id" uuid,
	"photo_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"field_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"handoff" boolean DEFAULT false NOT NULL,
	"handoff_note" text DEFAULT '' NOT NULL,
	"wait_payment" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_sandbox_sessions" ADD COLUMN "script_step_id" uuid;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "script_step_id" uuid;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "script_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "script_payment_turn_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sales_script_steps" ADD CONSTRAINT "sales_script_steps_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_script_steps" ADD CONSTRAINT "sales_script_steps_parent_id_sales_script_steps_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."sales_script_steps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_script_steps" ADD CONSTRAINT "sales_script_steps_stage_id_stages_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."stages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sales_script_steps_agent_parent_position_idx" ON "sales_script_steps" USING btree ("agent_id","parent_id","position");--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_script_step_id_sales_script_steps_id_fk" FOREIGN KEY ("script_step_id") REFERENCES "public"."sales_script_steps"("id") ON DELETE set null ON UPDATE no action;