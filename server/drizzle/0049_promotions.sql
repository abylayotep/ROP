CREATE TABLE "promotion_items" (
	"promotion_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"promo_price" integer NOT NULL,
	CONSTRAINT "promotion_items_promotion_id_variant_id_pk" PRIMARY KEY("promotion_id","variant_id"),
	CONSTRAINT "promotion_items_promo_price_check" CHECK ("promotion_items"."promo_price" >= 0)
);
--> statement-breakpoint
CREATE TABLE "promotions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"ends_at" timestamp with time zone,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "promotion_items" ADD CONSTRAINT "promotion_items_promotion_id_promotions_id_fk" FOREIGN KEY ("promotion_id") REFERENCES "public"."promotions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_items" ADD CONSTRAINT "promotion_items_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "promotion_items_variant_idx" ON "promotion_items" USING btree ("variant_id");--> statement-breakpoint
CREATE INDEX "promotions_agent_position_idx" ON "promotions" USING btree ("agent_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "promotions_one_active_per_agent" ON "promotions" USING btree ("agent_id") WHERE "promotions"."active";