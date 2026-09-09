CREATE TABLE "kb_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"note_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"heading" text DEFAULT '' NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"kind" text DEFAULT 'other' NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('russian', coalesce(title, '')), 'A') || setweight(to_tsvector('russian', coalesce(content, '')), 'B')) STORED NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"from_note_id" uuid NOT NULL,
	"to_note_id" uuid,
	"target" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"source_id" uuid,
	"path" text NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"kind" text DEFAULT 'other' NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"edited" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kb_notes_agent_path_key" UNIQUE("agent_id","path")
);
--> statement-breakpoint
ALTER TABLE "kb_chunks" ADD CONSTRAINT "kb_chunks_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_chunks" ADD CONSTRAINT "kb_chunks_note_id_kb_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."kb_notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_links" ADD CONSTRAINT "kb_links_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_links" ADD CONSTRAINT "kb_links_from_note_id_kb_notes_id_fk" FOREIGN KEY ("from_note_id") REFERENCES "public"."kb_notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_links" ADD CONSTRAINT "kb_links_to_note_id_kb_notes_id_fk" FOREIGN KEY ("to_note_id") REFERENCES "public"."kb_notes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_notes" ADD CONSTRAINT "kb_notes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_notes" ADD CONSTRAINT "kb_notes_source_id_kb_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."kb_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "kb_chunks_agent_kind_idx" ON "kb_chunks" USING btree ("agent_id","kind");--> statement-breakpoint
CREATE INDEX "kb_chunks_search_idx" ON "kb_chunks" USING gin ("search");--> statement-breakpoint
CREATE INDEX "kb_chunks_note_ordinal_idx" ON "kb_chunks" USING btree ("note_id","ordinal");--> statement-breakpoint
CREATE INDEX "kb_links_agent_target_idx" ON "kb_links" USING btree ("agent_id","to_note_id");--> statement-breakpoint
CREATE INDEX "kb_links_from_idx" ON "kb_links" USING btree ("from_note_id");--> statement-breakpoint
CREATE INDEX "kb_notes_agent_updated_idx" ON "kb_notes" USING btree ("agent_id","updated_at");
--> statement-breakpoint
-- Every record becomes one note in the folder its kind named, and one section. A loop, not
-- a window function: row_number() computes every record's suffix from its own title group in
-- one pass and cannot see the paths that pass is producing, so a record already titled
-- «Дверь (2)» and a second record titled «Дверь» can both compute to «Товары/Дверь (2)» and
-- abort the migration on the unique index. Walking the rows in order and probing kb_notes for
-- a free path before each insert is the row-by-row equivalent of "already taken, try the next
-- ordinal" — the loop runs once, on at most a few thousand rows, and correctness here matters
-- more than doing it set-wise.
DO $$
DECLARE
  item RECORD;
  folder text;
  base_path text;
  candidate_path text;
  suffix integer;
BEGIN
  FOR item IN SELECT * FROM kb_items ORDER BY created_at, id LOOP
    folder := CASE item.kind
      WHEN 'product'   THEN 'Товары/'
      WHEN 'qa'        THEN 'Вопросы-ответы/'
      WHEN 'procedure' THEN 'Процедуры/'
      WHEN 'contact'   THEN 'Контакты/'
      ELSE 'Прочее/'
    END;
    base_path := folder || replace(item.title, '/', '∕');
    candidate_path := base_path;
    suffix := 2;
    WHILE EXISTS (
      SELECT 1 FROM kb_notes WHERE agent_id = item.agent_id AND path = candidate_path
    ) LOOP
      candidate_path := base_path || ' (' || suffix || ')';
      suffix := suffix + 1;
    END LOOP;

    INSERT INTO kb_notes (id, agent_id, source_id, path, title, body, kind, edited, created_at, updated_at)
    VALUES (
      item.id, item.agent_id, item.source_id, candidate_path, item.title, item.content,
      item.kind, item.edited, item.created_at, item.updated_at
    );
  END LOOP;
END $$;
--> statement-breakpoint
INSERT INTO kb_chunks (agent_id, note_id, ordinal, heading, title, content, kind, created_at, updated_at)
SELECT n.agent_id, n.id, 0, '', n.title, n.body, n.kind, n.created_at, n.updated_at
FROM kb_notes n;
--> statement-breakpoint
DROP TABLE "kb_items" CASCADE;