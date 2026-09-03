-- Gives the default funnel to every agent that has none.
--
-- `seedFunnel` runs only inside POST /accounts/:id/agents, so every agent created before
-- that route existed — including the one this product is actually running on — has zero
-- stages. Zero stages means an empty board, no `success` stage, and therefore a zero in
-- every number the statistics and the ad events derive from a sale.
--
-- The nine rows below are DEFAULT_STAGES in server/src/lib/funnel.ts: same names, colours,
-- kinds and positions 0..8. Kept as literals rather than read from the code because a
-- migration records what the database was given on the day it ran; a later edit to that
-- constant must not silently rewrite history. If the constant changes, this file does not.
--
-- Only agents with no stages at all are touched, which makes this safe to run twice and
-- keeps it away from any funnel an owner has already reshaped.
INSERT INTO "stages" ("agent_id", "name", "color", "kind", "position")
SELECT a."id", d."name", d."color", d."kind", d."position"
FROM "agents" a
CROSS JOIN (VALUES
	('Новый лид', '#8a94a6', 'active', 0),
	('В диалоге', '#4b8ef0', 'active', 1),
	('Интерес проявлен', '#4b8ef0', 'active', 2),
	('Квалифицирован', '#7b61ff', 'qualified', 3),
	('Предложение отправлено', '#e0a13a', 'active', 4),
	('Готов к покупке', '#e0a13a', 'active', 5),
	('Счёт отправлен', '#e0a13a', 'awaiting_payment', 6),
	('Продажа', '#0d9668', 'success', 7),
	('Отказ', '#d24b4b', 'failure', 8)
) AS d("name", "color", "kind", "position")
WHERE NOT EXISTS (SELECT 1 FROM "stages" s WHERE s."agent_id" = a."id");
