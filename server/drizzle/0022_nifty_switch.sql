CREATE TABLE "linked_history_mappings" (
	"number_id" uuid NOT NULL,
	"lid" text NOT NULL,
	"phone" text NOT NULL,
	CONSTRAINT "linked_history_mappings_number_id_lid_pk" PRIMARY KEY("number_id","lid")
);
--> statement-breakpoint
CREATE TABLE "linked_history_packets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number_id" uuid NOT NULL,
	"digest" text NOT NULL,
	"notification" text,
	"payload" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"counts" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "linked_history_packet_digest" UNIQUE("number_id","digest")
);
--> statement-breakpoint
ALTER TABLE "linked_history_mappings" ADD CONSTRAINT "linked_history_mappings_number_id_whatsapp_numbers_id_fk" FOREIGN KEY ("number_id") REFERENCES "public"."whatsapp_numbers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linked_history_packets" ADD CONSTRAINT "linked_history_packets_number_id_whatsapp_numbers_id_fk" FOREIGN KEY ("number_id") REFERENCES "public"."whatsapp_numbers"("id") ON DELETE cascade ON UPDATE no action;