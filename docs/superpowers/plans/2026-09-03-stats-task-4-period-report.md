# Task 4 — The period report: funnel, sources, money

**Depends on:** tasks 2 and 3.
**Blocks:** task 5.

## Why

This is the task the stage exists for, and the one where a wrong decision is invisible on the
screen. Three rules govern it: a lead is counted once per stage, a number that cannot be
computed is `null` rather than zero, and no amount of money passes through a double.

## The route

- [ ] `GET /api/agents/:agentId/stats/period?period=day|week|month` in `server/src/api/stats.ts`,
  any member. Parse with `lib/period.ts`; default `week`; 400 «Неизвестный период»; answer
  `since` back.
- [ ] Four statements in one `Promise.all` — the funnel, the aggregate counters, the sources,
  the money. None reads another's result.

## The funnel

- [ ] The chain is the agent's **current** stages with `kind <> 'failure'`, in `position` order.
  Comment why: «Отказ» sits at position 8, after «Продажа», and a chain that walked through it
  would read a refusal as a step towards a sale.
- [ ] `entered` per stage:
  `count(distinct t.conversation_id)` over `stage_transitions` where `agent_id = $1`,
  `occurred_at >= since`, grouped by `to_stage_id`. Left-joined onto the stage list in Node so
  a stage nobody entered appears with `0` rather than vanishing.
- [ ] `distinct` is the whole defence against a lead sent back for a second attempt inflating
  the column it returned to. Say so in a comment.
- [ ] **No monotonic closure.** Do not count a lead into the stages it skipped. A lead dragged
  from «Новый лид» to «Продажа» entered two stages; inventing the three between them would be
  precisely wrong for a funnel whose last position is a refusal.
- [ ] `conversion` = `entered / entered(previous)`, computed in Node over integers (a ratio is
  not money). `null` on the first step, and `null` — never `0` — when the previous step has no
  entries: nothing to divide by is not zero per cent.
- [ ] Three counters from the same window, each `::int`:
  - `failureEntries` — distinct conversations entering any `failure` stage.
  - `backwardMoves` — rows with `to_position < from_position` (not distinct: how often it
    happens is the question).
  - `deletedStageEntries` — rows with `to_stage_id is null`, plus `deletedStageNames` from
    `distinct to_name` of those rows, capped at, say, ten with the tail dropped. This is what
    keeps a funnel whose totals do not add up from being a mystery.

## Sources

- [ ] Cohort: `conversations` with `agent_id = $1` and `created_at >= since`. The click
  happened then, and cohorting by creation is what makes two periods comparable.
- [ ] `newLeads` = the whole cohort. `leadsFromAds` = those with `ad_source_id is not null` or
  `ctwa_clid is not null`.
- [ ] Group by `ad_source_id`. Rows with a `ctwa_clid` and no `ad_source_id` collapse into one
  entry with `sourceId: null` — the screen labels it «Реклама без идентификатора объявления».
  Rows with neither are not sources and are the difference between the two counts above.
- [ ] Per source: `leads`, `withClickId` (`count(*) filter (where ctwa_clid is not null)`),
  `won` (standing **now** in a stage of `kind = 'success'` — a fact about the present,
  available for every lead, and not a transition), `headline` and `sourceType` from any row of
  the group (`max()` is fine; they do not vary within an ad).
- [ ] `paidTotal` per source: **every** paid order of those conversations, whatever its
  `paid_at`, so a lead who clicked in the window and paid a month later still credits the ad.
  This makes a past period's figure grow after the fact. That is correct for attribution, and
  task 5 says it on the card in words.
- [ ] Order by `leads desc`, then `sourceId` so two equal sources do not swap between reloads.

## Money

All of it in Postgres, all of it out as text. The exact expressions:

- [ ] `paidOrders`: `count(*)::int` over paid orders of the agent with `paid_at >= since` and
  `currency = <the agent's currency>`.
- [ ] `paidTotal`: `coalesce(sum(o.amount), 0)::numeric(16,2)::text`.
- [ ] `averageOrder`: `round(avg(o.amount), 2)::numeric(16,2)::text`.
- [ ] `revenuePerLead`:
  `round(sum(o.amount) / nullif(<new leads in the window>, 0), 2)::numeric(16,2)::text`.
- [ ] `otherCurrencyOrders`: `count(*)::int` of paid orders in the window whose currency is not
  the agent's. Excluded from every sum and counted so the exclusion is visible rather than
  merely missing.
- [ ] Comments to carry, because the next reader will want to widen or narrow one of these:
  - `sum(numeric)` returns `numeric` — exact, arbitrary precision, no float in the aggregate.
  - The cast is **wider than the column** deliberately: `numeric(14,2)` on a total would raise
    `numeric field overflow` and fail the whole request instead of one card. `board.ts` made
    the same choice for the same reason.
  - `::text` makes the value characters before the driver sees it, so nothing relies on how
    `pg` happens to decode `numeric`.
  - `round(numeric, int)` is exact decimal rounding, not float rounding.
  - `nullif` rather than a guard in Node: zero leads yields `null`, and `coalesce(…, 0)` would
    print «0 ₸ с лида» about a period in which nothing was sold to nobody.
- [ ] `money` is `null` when `paidOrders === 0` — `AiUsage.total`'s rule. A row of zeros reads
  as a fact about the business; the absence of any paid order is not one.

## Contract

- [ ] `FunnelStep`, `StatsSource`, `StatsMoney`, `StatsPeriodReport` exactly as the spec lists.
  Every money field `string` or `string | null`, and a comment on each saying it is a string
  for the reason `Order.amount` is one.
- [ ] `rakurs/src/api/index.ts`: `getStatsPeriod(agentId, period, signal)`.

## Tests — `server/test/stats-period.test.ts`

Build the fixtures by moving leads through the real PATCH route, not by inserting transitions.

- [ ] Conversion is `null` on the first step and `null` when the previous step has no entries.
- [ ] A lead that entered one stage twice counts once there.
- [ ] A backwards move counts in the target stage and in `backwardMoves`.
- [ ] A `failure` stage is absent from `funnel` and present in `failureEntries`.
- [ ] Deleting a stage after leads passed through it leaves `deletedStageEntries` and its name.
- [ ] A move older than the window is excluded; one inside it is included.
- [ ] `money` is `null` with no paid orders; a pending and a cancelled order do not count.
- [ ] An amount a double cannot hold round-trips exactly — `999999999.99` summed with `0.01`
  reads back `1000000000.00`, as a string, character for character.
- [ ] An order in another currency is excluded from `paidTotal` and counted in
  `otherCurrencyOrders`.
- [ ] `revenuePerLead` is `null` when the window has no new leads, even though there is money.
- [ ] A source's `paidTotal` includes an order paid after the window closed.
- [ ] A conversation with `ctwa_clid` and no `ad_source_id` lands in the `sourceId: null` row.
- [ ] Another agent's transitions, conversations and orders are absent from every figure.
- [ ] An unknown `period` answers 400; another account's agent answers 404.

## Acceptance criteria

- [ ] `npm --prefix server test` and `npm --prefix server run typecheck` green.
- [ ] `npm --prefix rakurs run typecheck` green.
- [ ] No `Number()`, `parseFloat` or arithmetic on any amount anywhere on the server path.
- [ ] Grep confirms every aggregate over `orders.amount` in this file ends `::text`.

## Before task 5 starts

Both endpoints answer with real numbers against a seeded agent, and every `null` the contract
allows has a test that produces it — the screen is written against behaviour, not hope.
