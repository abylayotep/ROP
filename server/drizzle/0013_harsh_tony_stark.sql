CREATE TABLE "agent_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"category" text NOT NULL,
	"text" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"origin" text DEFAULT 'manual' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"warning" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coach_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"role" text NOT NULL,
	"text" text NOT NULL,
	"proposal" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"conversation_id" uuid,
	"ai_reply_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_rules" ADD CONSTRAINT "agent_rules_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_messages" ADD CONSTRAINT "coach_messages_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_messages" ADD CONSTRAINT "coach_messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_messages" ADD CONSTRAINT "coach_messages_ai_reply_id_ai_replies_id_fk" FOREIGN KEY ("ai_reply_id") REFERENCES "public"."ai_replies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_rules_agent_category_idx" ON "agent_rules" USING btree ("agent_id","category","position");--> statement-breakpoint
CREATE INDEX "coach_messages_agent_created_idx" ON "coach_messages" USING btree ("agent_id","created_at");
--> statement-breakpoint
-- Every paragraph of the old instructions becomes one rule about the business, in the order
-- it was written. Everything lands in 'business': guessing an owner's intent during a
-- migration would silently change what their agent does, and re-categorising afterwards is
-- one click.
--
-- A paragraph over the column's 500-character practical cap (enforced by the rules API, not
-- by a check constraint here) is cut on sentence boundaries so no paragraph is truncated. A
-- sentence that is *itself* over 500 characters — the brief's own draft of this migration
-- dropped that row outright, silently discarding whatever text sat on it — is cut again into
-- fixed 500-character pieces instead, so every character of the original field survives
-- somewhere. An empty `instructions` field (the default for a never-configured agent) and a
-- paragraph of exactly 500 characters both fall out of this correctly on their own: the first
-- produces one all-blank "paragraph" that `trim(...) <> ''` throws away before any row is
-- built, and the second is `<= 500`, so it takes the first branch untouched.
--
-- `position` is a single `row_number()` per agent over every fragment, ordered by where it
-- sat in the original text (paragraph, then sentence, then piece). The brief's own two-insert
-- version restarted its own counter at 1000 inside every paragraph, so two long paragraphs on
-- the same agent produced colliding positions and an order the prompt would not have shown
-- the owner. A single ordered sequence cannot collide.
WITH fragments AS (
  -- A paragraph that already fits becomes one rule, whole.
  SELECT a.id AS agent_id, p.ord AS para_ord, 0 AS sentence_ord, 0 AS piece_ord,
         trim(p.para) AS text
  FROM agents a,
       LATERAL regexp_split_to_table(a.instructions, '\n\s*\n') WITH ORDINALITY AS p(para, ord)
  WHERE trim(p.para) <> '' AND length(trim(p.para)) <= 500

  UNION ALL

  -- A sentence of an over-long paragraph that fits on its own.
  SELECT a.id, p.ord, s.ord, 0,
         trim(s.sentence)
  FROM agents a,
       LATERAL regexp_split_to_table(a.instructions, '\n\s*\n') WITH ORDINALITY AS p(para, ord),
       LATERAL regexp_split_to_table(trim(p.para), '(?<=[.!?])\s+') WITH ORDINALITY AS s(sentence, ord)
  WHERE length(trim(p.para)) > 500 AND trim(s.sentence) <> '' AND length(trim(s.sentence)) <= 500

  UNION ALL

  -- A sentence still over 500 characters after splitting on punctuation is cut into fixed
  -- 500-character pieces, in order, rather than being dropped.
  SELECT a.id, p.ord, s.ord, piece.ord,
         substring(trim(s.sentence) FROM piece.start FOR 500)
  FROM agents a,
       LATERAL regexp_split_to_table(a.instructions, '\n\s*\n') WITH ORDINALITY AS p(para, ord),
       LATERAL regexp_split_to_table(trim(p.para), '(?<=[.!?])\s+') WITH ORDINALITY AS s(sentence, ord),
       LATERAL generate_series(1, length(trim(s.sentence)), 500) WITH ORDINALITY AS piece(start, ord)
  WHERE length(trim(p.para)) > 500 AND length(trim(s.sentence)) > 500
)
INSERT INTO agent_rules (agent_id, category, text, origin, position)
SELECT agent_id, 'business', text, 'manual',
       row_number() OVER (PARTITION BY agent_id ORDER BY para_ord, sentence_ord, piece_ord) - 1
FROM fragments;
--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "instructions";