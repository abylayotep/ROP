-- Merge every awaiting_payment stage into its agent's sale stage.
-- See docs/superpowers/specs/2026-09-14-chat-payment-funnel-design.md.
INSERT INTO stage_transitions (agent_id, conversation_id, from_stage_id, to_stage_id, from_name, to_name, to_kind, from_position, to_position, moved_by, occurred_at)
SELECT c.agent_id, c.id, a.id, s.id, a.name, s.name, s.kind, a.position, s.position, 'system', now()
FROM conversations c
JOIN stages a ON a.id = c.stage_id AND a.kind = 'awaiting_payment'
JOIN stages s ON s.agent_id = a.agent_id AND s.kind = 'success';
--> statement-breakpoint
UPDATE crm_analyses ca SET analyzed_message_id = NULL, status = 'pending', lease_token = NULL, lease_until = NULL, updated_at = now()
FROM conversations c
JOIN stages a ON a.id = c.stage_id AND a.kind = 'awaiting_payment'
JOIN stages s ON s.agent_id = a.agent_id AND s.kind = 'success'
WHERE ca.conversation_id = c.id;
--> statement-breakpoint
UPDATE conversations c SET stage_id = s.id, stage_set_at = now(), stage_set_by = 'system'
FROM stages a
JOIN stages s ON s.agent_id = a.agent_id AND s.kind = 'success'
WHERE c.stage_id = a.id AND a.kind = 'awaiting_payment';
--> statement-breakpoint
UPDATE stages SET kind = 'active'
WHERE kind = 'awaiting_payment'
  AND NOT EXISTS (SELECT 1 FROM stages s WHERE s.agent_id = stages.agent_id AND s.kind = 'success');
--> statement-breakpoint
DELETE FROM stages WHERE kind = 'awaiting_payment';
--> statement-breakpoint
UPDATE stages SET position = r.pos
FROM (SELECT id, (row_number() OVER (PARTITION BY agent_id ORDER BY position, id) - 1)::int AS pos FROM stages) r
WHERE stages.id = r.id AND stages.position <> r.pos;
