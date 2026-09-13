CREATE TABLE "product_photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"media_path" text NOT NULL,
	"media_mime" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"filename" text DEFAULT '' NOT NULL,
	"caption" text,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"price" integer NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "product_variants_price_check" CHECK ("product_variants"."price" >= 0)
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_sandbox_turns" ADD COLUMN "photo_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "product_photo_id" uuid;--> statement-breakpoint
ALTER TABLE "product_photos" ADD CONSTRAINT "product_photos_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "product_photos_product_position_idx" ON "product_photos" USING btree ("product_id","position");--> statement-breakpoint
CREATE INDEX "product_variants_product_position_idx" ON "product_variants" USING btree ("product_id","position");--> statement-breakpoint
CREATE INDEX "products_agent_position_idx" ON "products" USING btree ("agent_id","position");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_product_photo_id_product_photos_id_fk" FOREIGN KEY ("product_photo_id") REFERENCES "public"."product_photos"("id") ON DELETE set null ON UPDATE no action;