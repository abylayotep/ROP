INSERT INTO "kb_generation_drafts" ("run_id", "draft_id")
SELECT DISTINCT "run_id", "draft_id"
FROM "kb_generation_proposals"
WHERE "fingerprint" LIKE 'raw:%' AND "draft_id" IS NOT NULL
ON CONFLICT ("run_id", "draft_id") DO NOTHING;--> statement-breakpoint
UPDATE "kb_drafts"
SET "status" = 'discarded'
WHERE "status" = 'open'
	AND "id" IN (
		SELECT DISTINCT "draft_id"
		FROM "kb_generation_proposals"
		WHERE "fingerprint" LIKE 'raw:%' AND "draft_id" IS NOT NULL
	);--> statement-breakpoint
INSERT INTO "kb_generation_raw_findings" (
	"id", "run_id", "batch_id", "fingerprint", "legacy_kind", "legacy_revision", "legacy_status",
	"legacy_draft_id", "legacy_draft_op_index", "legacy_note_id", "path", "body", "warnings", "sources", "created_at"
)
SELECT
	"id", "run_id", "batch_id", "fingerprint", "kind", "revision", "status",
	"draft_id", "draft_op_index", "note_id", "path", "body", "warnings", "sources", "created_at"
FROM "kb_generation_proposals"
WHERE "fingerprint" LIKE 'raw:%'
ON CONFLICT ("id") DO UPDATE SET
	"legacy_kind" = EXCLUDED."legacy_kind",
	"legacy_revision" = EXCLUDED."legacy_revision",
	"legacy_status" = EXCLUDED."legacy_status",
	"legacy_draft_id" = EXCLUDED."legacy_draft_id",
	"legacy_draft_op_index" = EXCLUDED."legacy_draft_op_index",
	"legacy_note_id" = EXCLUDED."legacy_note_id";--> statement-breakpoint
DELETE FROM "kb_generation_proposals" WHERE "fingerprint" LIKE 'raw:%';
