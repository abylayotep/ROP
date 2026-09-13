ALTER TABLE response_feedback ADD COLUMN request_key uuid;
ALTER TABLE response_feedback ADD COLUMN requested_by_user_id uuid;
ALTER TABLE response_feedback ADD COLUMN request_hash text;
ALTER TABLE response_feedback ADD COLUMN failure_reason text;
ALTER TABLE response_feedback ADD CONSTRAINT response_feedback_request_key UNIQUE (agent_id, requested_by_user_id, request_key);
ALTER TABLE response_feedback ADD CONSTRAINT response_feedback_request_identity_check CHECK (
  (request_key IS NULL AND requested_by_user_id IS NULL AND request_hash IS NULL)
  OR (request_key IS NOT NULL AND requested_by_user_id IS NOT NULL AND request_hash IS NOT NULL)
);
