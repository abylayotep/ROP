ALTER TABLE test_cases ADD COLUMN required_draft_id uuid REFERENCES kb_drafts(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX test_cases_required_draft_key ON test_cases(required_draft_id);
