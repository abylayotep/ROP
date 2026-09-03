# Task 4 — The period report: funnel, sources, money

**Status:** done. `npm --prefix server test` 806 passed (50 files), `npm --prefix server run
typecheck`, `npm --prefix rakurs run typecheck` and `npm --prefix rakurs run build` all green.
Migration count unchanged: `0011_long_jack_power.sql` is still the last one, because this task
adds no column.

## What landed

| File | Change |
|---|---|
| `packages/contract/index.ts` | `FunnelStep`, `StatsSource`, `StatsMoney`, `StatsPeriodReport`. |
| `server/src/api/stats.ts` | `GET /api/agents/:agentId/stats/period?period=day\|week\|month`. |
| `rakurs/src/api/index.ts` | `getStatsPeriod(agentId, period, signal)`. |
| `server/test/stats-period.test.ts` | New, 29 tests. |

777 → 806. All 29 are this task's.

## The route

Four statements in one `Promise.all`, none of which reads another's result: the chain, the
counters beside it, the sources, and the money together with the size of the cohort that
produced it. `lib/period.ts` parses `?period=`, defaults to `week`, and answers 400
«Неизвестный период»; `since` and `stageHistorySince` are both answered back.

### The funnel

The chain is the agent's **current** stages with `kind <> 'failure'`, in `position` order.
`entered` is `count(distinct t.conversation_id)` over transitions into that stage inside the
window — `distinct` is the whole defence against a lead sent back for a second attempt
inflating the column it returned to.

Two decisions worth naming, because both differ in letter from the plan while keeping its
stated purpose:

- **The zero-fill is a `LEFT JOIN` in SQL, not a merge in Node.** The plan asked for a read
  grouped by `to_stage_id` left-joined onto the stage list in Node, *so a stage nobody entered
  appears with `0` rather than vanishing*. `count(distinct …)` over no matched row already is
  that zero, so the join does in one statement what the merge would have done in two — and it
  is what keeps the count of statements at the four the plan asked for. The join needs no
  tenancy clause of its own: `to_stage_id` points at a row of `stages`, and the `where` has
  already restricted those to this agent.
- **`funnel` is `[]` when nothing moved**, which is the contract's «empty exactly when nothing
  moved». Otherwise the chain lists every non-failure stage, zeros included. The counters
  statement carries a plain `count(*)` for exactly this decision; a chain of nine zeros reads
  as «ни один лид никуда не дошёл», and the screen has to be able to tell the two apart.

No monotonic closure anywhere. `conversion` is `entered / entered(previous)` over integers in
Node, `null` on the first step and `null` — never `0` — when the previous step has no entries.

`failureEntries` reads the snapshot `to_kind` rather than joining `stages`, so a refusal into
a stage the owner has since deleted is still counted. `backwardMoves` is deliberately not
distinct. `deletedStageEntries` and `deletedStageNames` (capped at ten, tail dropped) are what
keep a funnel whose totals do not add up from being a mystery.

### The money, and the overflow guard

Every figure is summed, averaged, divided and rounded in Postgres and cast
`::numeric(16,2)::text`, so it reaches the driver as characters. `revenuePerLead` divides by
`nullif(<new leads in the window>, 0)`, so no leads yields `null` rather than «0 ₸ с лида».
`money` is `null` when `paidOrders === 0`. `grep` confirms no `Number(`, `parseFloat` or
`parseInt` anywhere in `api/stats.ts`, and every aggregate over `orders.amount` ends `::text`.

**The guard is proved, not asserted.** `test/stats-period.test.ts` → «holds a total that
numeric(14,2) could not» writes two orders at the column's ceiling (`999999999999.99` each).
Their sum has thirteen digits before the point and the column holds twelve. The test then runs
the *same* sum cast back to `::numeric(14,2)` and requires the driver to answer
`numeric field overflow` — read off `error.cause`, because drizzle's wrapper message only
repeats the SQL — before asserting the route answers `1999999999999.98`. Without the wider
cast that request would have 500'd instead of losing one card. A second test covers exactness
rather than range: `999999999.99 + 0.01` reads back `1000000000.00`, character for character,
which float64 cannot produce.

### The sources

Cohorted by `conversations.created_at` inside the window. `won` is where the lead stands
**now** in a stage of `kind = 'success'` — a fact about the present, so it is available for a
lead that moved before recording began. A source's `paidTotal` takes **every** paid order of
those conversations whatever its `paid_at`; the test that proves it gives the cohort an order
paid outside the window and asserts the source shows the money while `money` is `null`.
Threads with a `ctwa_clid` and no `ad_source_id` collapse into the single `sourceId: null`
row; threads with neither are the difference between `newLeads` and `leadsFromAds`. Ordered
`leads desc`, then the id `nulls last`, so nothing swaps between reloads.

## For task 5

- `stageHistorySince` is on **both** endpoints. The funnel is the only part of this answer it
  governs — sources and money are honest back to the day the number was connected — so the
  card must print the date on the movement card and must not imply it applies to the other
  two.
- Every `null` the contract allows has a test that produces it: `conversion` (first step, and
  empty denominator), `money`, `averageOrder`/`revenuePerLead` (via `money: null`),
  `revenuePerLead` alone (money with no new leads), `sourceId`, `sourceType`, `headline`.
- `funnel: []` and `funnel: [<nine zeros>]` are different states and mean different things.
- A source's money grows after the fact, by design. Say it on the card.

## Notes and one concern

- Inside a raw `sql` fragment the driver is handed no column to infer a type from, and a
  `Date` there reaches postgres.js as an object it refuses to serialise («The "string"
  argument must be of type string … Received an instance of Date»). The two cohort subqueries
  therefore spell the instant out: `${since.toISOString()}::timestamptz`. The drizzle
  comparison operators do this themselves, which is why only the fragments say it out loud.
  Worth knowing for anyone adding a fifth statement here.
- **Concern, small and deliberate.** `money` is `null` when `paidOrders === 0`, and
  `otherCurrencyOrders` lives inside `money`. A window holding *only* orders in some other
  currency therefore reports `money: null` and says nothing about the exclusion. That is what
  the plan specifies and it is the right default — a row of zeros would be worse — but nothing
  can change an agent's currency today, so the case is unreachable in practice and will stop
  being unreachable the day one can.
