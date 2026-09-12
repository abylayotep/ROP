INSERT INTO "kb_generation_drafts" ("run_id", "draft_id")
SELECT DISTINCT "run_id", "draft_id"
FROM "kb_generation_proposals"
WHERE "draft_id" IS NOT NULL
ON CONFLICT ("run_id", "draft_id") DO NOTHING;
