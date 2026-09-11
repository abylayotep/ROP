CREATE TABLE "linked_session_keys" (
	"whatsapp_number_id" uuid NOT NULL,
	"category" text NOT NULL,
	"key_id" text NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "linked_session_keys_whatsapp_number_id_category_key_id_pk" PRIMARY KEY("whatsapp_number_id","category","key_id")
);
--> statement-breakpoint
ALTER TABLE "whatsapp_numbers" DROP CONSTRAINT "whatsapp_numbers_phone_number_id_unique";--> statement-breakpoint
ALTER TABLE "whatsapp_numbers" ALTER COLUMN "phone_number_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "whatsapp_numbers" ALTER COLUMN "waba_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "whatsapp_numbers" ALTER COLUMN "access_token" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "whatsapp_numbers" ADD COLUMN "linked_jid" text;--> statement-breakpoint
ALTER TABLE "whatsapp_numbers" ADD COLUMN "linked_state" text;--> statement-breakpoint
ALTER TABLE "linked_session_keys" ADD CONSTRAINT "linked_session_keys_whatsapp_number_id_whatsapp_numbers_id_fk" FOREIGN KEY ("whatsapp_number_id") REFERENCES "public"."whatsapp_numbers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_numbers_phone_number_id_key" ON "whatsapp_numbers" USING btree ("phone_number_id") WHERE "whatsapp_numbers"."phone_number_id" is not null;--> statement-breakpoint
ALTER TABLE "whatsapp_numbers" ADD CONSTRAINT "whatsapp_numbers_cloud_columns_check" CHECK (
  connection_kind = 'linked'
  OR (phone_number_id IS NOT NULL AND waba_id IS NOT NULL AND access_token IS NOT NULL)
);--> statement-breakpoint
ALTER TABLE "whatsapp_numbers" ADD CONSTRAINT "whatsapp_numbers_linked_columns_check" CHECK (
  connection_kind <> 'linked'
  OR (linked_jid IS NOT NULL AND linked_state IS NOT NULL)
);
