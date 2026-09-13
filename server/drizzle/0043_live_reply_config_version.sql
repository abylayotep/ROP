ALTER TABLE ai_replies ADD COLUMN config_version integer;--> statement-breakpoint
ALTER TABLE response_feedback DROP CONSTRAINT response_feedback_snapshot_bounds_check;--> statement-breakpoint
ALTER TABLE response_feedback ADD CONSTRAINT response_feedback_snapshot_bounds_check CHECK (
  jsonb_typeof(snapshot) = 'object'
  and (snapshot - 'transcript' - 'responseText' - 'configVersion' - 'sourceIds' - 'sourceRecords') = '{}'::jsonb
  and jsonb_typeof(snapshot->'transcript') = 'string' and length(snapshot->>'transcript') <= 12000
  and jsonb_typeof(snapshot->'responseText') = 'string' and length(snapshot->>'responseText') <= 4000
  and jsonb_typeof(snapshot->'configVersion') in ('number', 'null')
  and jsonb_typeof(snapshot->'sourceIds') = 'array' and jsonb_array_length(snapshot->'sourceIds') <= 30
  and jsonb_typeof(snapshot->'sourceRecords') = 'array' and jsonb_array_length(snapshot->'sourceRecords') <= 30
  and pg_column_size(snapshot) <= 32768
);
