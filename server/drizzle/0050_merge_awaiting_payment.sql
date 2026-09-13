-- Merge every awaiting_payment stage into its agent's sale stage.
-- See docs/superpowers/specs/2026-09-14-chat-payment-funnel-design.md.
-- Analyses of the merged leads are reset after release, not here: the old API keeps running
-- while migrations apply and would re-analyse them. See docs/crm-kaspi.md.
INSERT INTO stage_transitions (agent_id, conversation_id, from_stage_id, to_stage_id, from_name, to_name, to_kind, from_position, to_position, moved_by, occurred_at)
SELECT c.agent_id, c.id, a.id, s.id, a.name, s.name, s.kind, a.position, s.position, 'system', now()
FROM conversations c
JOIN stages a ON a.id = c.stage_id AND a.kind = 'awaiting_payment'
JOIN stages s ON s.agent_id = a.agent_id AND s.kind = 'success';
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
--> statement-breakpoint
-- The default texts 0046_stage_agent_goal wrote for the stages around the merged one: the
-- ready-to-buy goal takes over helping the customer pay, and the sale stage is no longer
-- only a Kaspi confirmation. Texts an owner has changed are left alone.
UPDATE stages SET
  description = CASE WHEN description = 'Клиент сказал, что берёт, и согласовал, что именно заказывает.'
    THEN 'Клиент сказал, что берёт, и согласовал, что именно заказывает. Сюда же — заказ согласован и ждём оплату.' ELSE description END,
  agent_goal = CASE WHEN agent_goal = 'Подтверди состав заказа, назови итоговую сумму и уточни данные для доставки. Затем предложи способ оплаты.'
    THEN 'Подтверди состав заказа, назови итоговую сумму и уточни данные для доставки. Затем предложи способ оплаты и помоги оплатить по инструкциям владельца. Никогда не говори, что оплата получена.' ELSE agent_goal END
WHERE btrim(name) = 'Готов к покупке';
--> statement-breakpoint
UPDATE stages SET description = 'Оплата прошла: её подтвердил Kaspi, клиент написал, что оплатил, или продавец подтвердил поступление денег.'
WHERE btrim(name) = 'Оплачено' AND kind = 'success' AND description = 'Оплата подтверждена.';
