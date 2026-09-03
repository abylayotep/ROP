# Task 3 — The shared period, and the snapshot endpoint

**Depends on:** task 1 (for `stageHistorySince`). Independent of task 2.
**Blocks:** task 4 (imports the period module), task 5 (reads this endpoint).

## Why

`api/ai.ts` already decided what «Сутки», «Неделя» and «Месяц» mean: rolling windows of 1, 7
and 30 days, a `?period=` query, 400 «Неизвестный период», and the window's start answered
back so the screen names the instant instead of guessing one from its own clock. A second
definition of the same three buttons is a second thing to keep in step. Extract it.

The snapshot is the other half of this task because it is the card that answers «почему
воронка пустая, у меня двести лидов». It has no period, and that absence is load-bearing.

## The period module

- [ ] New `server/src/lib/period.ts`, moving from `api/ai.ts` unchanged in behaviour:
  `PERIOD_DAYS`, `DAY_MS`, the `z.enum(['day','week','month'])` query schema, and
  `periodSince(period): Date`.
- [ ] Keep the comment explaining why a month is thirty rolling days and not a calendar one —
  it answers «во сколько мне обходится», not «сколько я потратил в августе».
- [ ] `api/ai.ts` imports it and loses its own copies. Its behaviour must not change: the
  existing `server/test/ai-usage.test.ts` is the proof and is not edited in this task.
- [ ] Contract: add `export type Period = 'day' | 'week' | 'month';` and redefine
  `AiUsagePeriod` as `Period`. The old name stays — the AI screen imports it, and renaming it
  is churn in a file this stage has no business touching.

## The snapshot endpoint

- [ ] New `server/src/api/stats.ts` with `registerStatsRoutes(app, db, guard)`, registered in
  `server/src/api/server.ts` beside the others.
- [ ] `GET /api/agents/:agentId/stats/current`, `preHandler: [guard, anyMember]`. Any member,
  for the reason `ai/usage` gives: the settings are the owner's, what the funnel did is the
  company's.
- [ ] Two statements in one `Promise.all`, the shape `board.ts` uses:
  - The agent's stages, ordered by `position`.
  - `select stage_id, count(*)::int from conversations where agent_id = $1 group by stage_id`.
- [ ] Assemble in Node: every current stage appears, including the ones with no leads — a
  stage missing from the list reads as a stage that does not exist. Conversations whose
  `stage_id` is null become `unsorted`; conversations pointing at a stage that no longer
  exists cannot happen (the delete route refuses a stage that holds any) but fall into
  `unsorted` rather than nowhere if they ever do.
- [ ] `total` is the sum of all buckets, computed from the same rows — not a third `count(*)`,
  which could disagree with them.
- [ ] `stageHistorySince` comes from `req.agent!.stageHistorySince`, so this card can carry
  the sentence that explains the card below it.
- [ ] Contract: `StageStanding` and `StatsCurrent` exactly as the spec lists them, in a new
  `/* ── Статистика ── */` section, commented in the file's existing bilingual style.
- [ ] `rakurs/src/api/index.ts`: `getStatsCurrent(agentId, signal)`.

## Tests — `server/test/stats-current.test.ts`

- [ ] Every stage of the agent appears, in `position` order, including the empty ones.
- [ ] Leads with no stage land in `unsorted` and not in any stage.
- [ ] `total` equals stages plus unsorted.
- [ ] Another account's agent answers 404; a malformed agent id answers 404.
- [ ] A member (not owner) gets 200.
- [ ] An agent with no conversations returns every stage at zero, `unsorted: 0`, `total: 0` —
  the emptiness is the screen's to interpret, and the endpoint does not answer `null` here
  because «нет диалогов» is a fact the counts state correctly.
- [ ] `stageHistorySince` is present and parses as a date.

## Acceptance criteria

- [ ] `npm --prefix server test` and `npm --prefix server run typecheck` green, with
  `ai-usage.test.ts` passing unedited — that is the proof the extraction changed nothing.
- [ ] `npm --prefix rakurs run typecheck` green (the contract moved).
- [ ] `api/ai.ts` has no local `PERIOD_DAYS`, `DAY_MS` or period enum left.

## Before task 4 starts

`lib/period.ts` is the only definition of a period, and `api/stats.ts` exists with its guard,
its registration and one working route to add the second one beside.
