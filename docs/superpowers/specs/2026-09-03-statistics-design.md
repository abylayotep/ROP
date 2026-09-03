# Statistics: the funnel, conversion, ad sources

**Date:** 2026-09-03
**Status:** Approved. Ready for implementation planning.
**Sub-project:** 7 of 7 in the pleep-model rebuild — the last one.

## Goal

Answer three questions an owner asks about money: where leads stop moving, which ads bring
the ones who pay, and how much came in. Nothing here writes to a customer, calls Meta, or
spends a model's tokens: it reads what the first six stages recorded, and adds the one
recording that is missing.

## Starting point

| | |
|---|---|
| Funnel | `stages` per agent, ordered by `position`, one of kind `success`. `conversations.stage_id` says where a lead stands **now**. |
| History | **None.** `conversations` keeps `stage_id`, `stage_set_at`, `stage_set_by` — the last move only. `funnel-message.ts` sends a template on a move and stores nothing. |
| Money | `orders.amount numeric(14,2)`, `status`, `paid_at`, `currency`. |
| Ads | `conversations.ctwa_clid`, `ad_source_id`, `ad_source_type`, `ad_headline`, `ad_body`, filled once from the first message's `referral` block. |
| Period selector | `GET /api/agents/:id/ai/usage?period=day\|week\|month` — rolling windows of 1, 7 and 30 days, `since` answered back, `total: null` when the period is empty. |
| Screen | `/a/:agentId/stats` renders `SectionScreen` with «появятся на этапе 7». |

## The finding this stage is built around

**A funnel with conversion between stages cannot be computed from what exists.** A lead that
stood in «Новый лид» on Monday and «Оплата» on Friday left one row behind, and that row says
«Оплата, Friday». There is no record it was ever in «Новый лид», and nothing to reconstruct
one from: not `messages` (a move leaves no message when the stage has no template, and the
template does not name the stage it came from), not `capi_events` (only `qualified` and only
for ad-sourced threads), not `notes` (written only when an auto-message fails).

So the funnel needs a new append-only table, written from the moment this stage ships, and
**there is nothing to backfill it from.** Two other numbers are not in that position and must
not be presented as though they were:

| Number | Honest about the past? |
|---|---|
| Where every lead stands now | **Yes.** `conversations.stage_id` is complete for every lead ever. |
| Which ad a thread came from | **Yes.** The advertising columns were filled at stage 2 for every click since the number was connected. |
| Paid orders and their sums | **Yes.** `orders` has been written since stage 3. |
| Movement between stages | **No.** Starts on the day this migration runs. |

## Decisions

| Decision | Choice | Why |
|---|---|---|
| History | New `stage_transitions`, append-only | The only way to know a lead was somewhere it no longer is. |
| Backfill | **None** | See below. |
| Recording point | `agents.stage_history_since`, stamped by the migration | The screen must be able to name the date, not imply one. |
| Write path | Inside the transaction that moves the stage; a failure fails the move | Unlike the CAPI queue, this is one insert into our own table in a transaction already open. A best-effort history produces conversion numbers that are wrong and unfalsifiable. |
| Snapshot vs snapshot | Both the stage id **and** its name, kind and position at the time | An owner may delete an empty stage that leads passed through. `on delete set null` alone would erase which stage. |
| Two endpoints, not one | `/stats/current` (no period) and `/stats/period?period=` | The split is the anti-confusion device: the snapshot has no period control because it does not have a period. One endpoint would invite the reader to think it did. |
| Period vocabulary | The AI usage endpoint's, moved to `lib/period.ts` and shared | A second convention for the same three buttons is a second thing to keep in step. |
| Money | `numeric` summed in Postgres, `::text` to the browser | Stage 6's rule. See «Money», which says how for a sum, an average and a per-lead figure. |

### Why nothing is backfilled

The tempting backfill is one synthetic row per conversation from `stage_id` / `stage_set_at`
/ `stage_set_by`, with an unknown `from`. It is rejected, and not on purity grounds:

- A lead moved five times would contribute **one** entry, landing entirely on the stage it
  happens to be standing in today. Every earlier stage would show fewer entries than the one
  after it, and the conversion between them would print above 100% — a number that is not
  merely imprecise but visibly impossible, in the one place an owner is deciding about money.
- `stage_set_at` is when the **last** move happened. Placed in a period window it dates a
  lead's whole history to one instant that is usually inside the current week.
- The synthetic row would be indistinguishable from a real one a week later.

So: the funnel counts what it recorded, and the screen says from when.

## Data model

Migration `0011`:

```
stage_transitions
  id               uuid pk
  agent_id         uuid  not null  fk→agents          cascade
  conversation_id  uuid  not null  fk→conversations   cascade
  from_stage_id    uuid  null      fk→stages          set null
  to_stage_id      uuid  null      fk→stages          set null
  from_name        text  null      -- snapshot, null exactly when from_stage_id was null
  to_name          text  not null  -- snapshot
  to_kind          text  not null  -- snapshot
  to_position      int   not null  -- snapshot
  from_position    int   null
  moved_by         text  not null  -- 'operator' | 'ai' | 'scenario' | 'system'
  moved_by_user_id uuid  null      fk→users           set null
  occurred_at      timestamptz not null default now()
  index (agent_id, occurred_at)
  index (conversation_id, occurred_at)

agents
  + stage_history_since timestamptz not null default now()
```

`conversation_id` cascades rather than nulls, unlike `capi_events.conversation_id`: the funnel
counts **distinct conversations** per stage, and a row whose conversation is gone cannot be
counted distinctly without inventing an identity for it. A report already sent to Meta is a
fact about the outside world; a row here is only ever an input to our own arithmetic.

The migration stamps `stage_history_since` at `now()` for every existing agent — that is the
instant recording begins — and new agents take the column default.

## What the funnel counts

**One entry per lead per stage.** For a period:

1. The chain is the agent's **current** stages of kind other than `failure`, in `position`
   order. `failure` is excluded from the chain and reported beside it: «Отказ» sits at
   position 8, after «Продажа», and a chain that walked through it would read a refusal as a
   step towards a sale.
2. A step's `entered` is `count(distinct conversation_id)` of transitions **into** that stage
   whose `occurred_at` falls in the period.
3. `conversion` is `entered(step) / entered(previous step)`. Null on the first step, and null
   — never zero — when the previous step has no entries: nothing to divide by is not 0%.

Consequences, stated on the screen rather than smoothed over:

- **A lead that skips a stage is not counted in it.** Dragged from «Новый лид» straight to
  «Продажа», it enters two stages and no others. That is what happened; a monotonic closure
  («reached this stage or any later one») would invent the three columns in between, and
  would be exactly wrong for a funnel whose last position is a refusal.
- **A lead counted twice in one stage is counted once.** `distinct` is what makes a lead sent
  back for a second attempt not inflate the column it returned to.
- **A move backwards is recorded and counted as an entry.** It is what happened, and how often
  it happens is worth knowing: `backwardMoves` (`to_position < from_position`) is its own
  figure on the card.

**Where an existing lead enters the funnel: on its next move, and not before.** A lead that
has stood in «Счёт отправлен» since August contributes nothing until somebody moves it. The
screen's answer to «почему воронка пустая, у меня двести лидов» is the snapshot card above
it, which counts all two hundred.

Transitions into a stage that has since been deleted have no column in the chain. They are
not silently dropped: `deletedStageEntries` counts them and the card names the stages from
the snapshot columns, so a funnel whose totals do not add up says why.

## Who is recorded

Every mover, through one helper — `recordStageMove(executor, …)` in
`server/src/lib/funnel-history.ts`, taking the `Executor` type `lib/funnel.ts` already
defines so it runs inside the caller's open transaction.

| Writer | `moved_by` |
|---|---|
| `api/leads.ts`, the operator's PATCH | `operator` |
| `lib/ai/turn.ts`, the agent's own move | `ai` |
| Anything later that writes `conversations.stage_id` | `scenario` / `system` |

`moved_by_user_id` is filled for `operator` and null otherwise. Nothing on the screen ranks
people by it in this stage — see «Out of scope» — but the move is not worth recording without
knowing who made it, and adding the column later means a gap in the history.

Rules the helper inherits from the two move paths, which are copies of one another:

- Called **only** when the guarded `UPDATE` returned a row. A request that lost the race
  changed nothing and must not record a move somebody else made.
- Not called on a move to the stage the lead is already in — both paths already return early.
- Not called by the sandbox: a dry run rolls back and writes nothing anywhere.
- The lead's first stage is recorded with `from_stage_id` and `from_name` null. It is an
  entry, and it is what gives the first column of the funnel a denominator.

## Money

`orders.amount` is `numeric(14,2)` and must not pass through a JavaScript double. Concretely,
for each of the three figures:

- **`sum(numeric)` returns `numeric`** in Postgres — arbitrary precision, exact, no float
  anywhere in the aggregate. (`sum(int)` returns `bigint`; only `sum(float8)` is a double.)
- Every money aggregate is written `…::numeric(16,2)::text`, exactly as `board.ts` does. The
  cast is **wider than the column** on purpose: amounts stop just under 10^12 and a handful of
  them add past that, and `::numeric(14,2)` on the total would raise `numeric field overflow`
  and fail the whole request instead of one card.
- `::text` means the column arriving in Node has type `text`. The value reaching the response
  is characters that were never parsed. This does not rely on `pg` returning `numeric` as a
  string by default — the SQL makes it text before the driver sees it.
- **The average** is `round(avg(o.amount), 2)::numeric(16,2)::text`. `avg(numeric)` returns
  numeric with extra scale, and `round(numeric, int)` is exact decimal rounding, not float
  rounding. The card says «в среднем» so a rounded figure is not read as an exact one.
- **The per-lead figure** — revenue divided by the leads that produced it — is
  `round(sum(o.amount) / nullif(count(distinct …), 0), 2)::numeric(16,2)::text`. `nullif`
  rather than a guard in Node: zero leads yields `null`, which reaches the contract as `null`
  and the screen as a sentence. `coalesce(…, 0)` here would print «0 ₸ с лида» about a period
  in which nothing was sold to nobody.
- **Currency is in the predicate, not assumed:** `and o.currency = <the agent's currency>`,
  the clause `board.ts` already carries. Orders in another currency are excluded from every
  sum and counted into `otherCurrencyOrders`, so an excluded amount is visible rather than
  merely missing.
- **The contract types every money field `string`, or `string | null`.** No `Number()` touches
  one on either side. The screen formats by replacing `.` with `,` and grouping the integer
  part by hand — not through `toLocaleString`, which takes a number.

## API

| Method | Path | Role | Returns |
|---|---|---|---|
| GET | `/api/agents/:agentId/stats/current` | member | Where every lead stands now. No query. |
| GET | `/api/agents/:agentId/stats/period?period=` | member | The funnel, the sources and the money for a window. |

Any member, not owner-only, for the reason `ai/usage` is: the settings are the owner's, but
what the funnel did is the company's.

`period` is `day` \| `week` \| `month`, defaulting to `week`, rejected with
400 «Неизвестный период», and the window is rolling — 1, 7 or 30 days back from now, computed
on the server and answered back as `since`. All of that is `lib/period.ts`, extracted from
`api/ai.ts` and imported by both, so there is one definition of what «Неделя» means.

Contract, in `packages/contract/index.ts`:

```ts
type Period = 'day' | 'week' | 'month';
type AiUsagePeriod = Period;                 // kept: the AI screen's existing name

interface StageStanding { stageId; name; color; kind: StageKind; position; leads: number }
interface StatsCurrent {
  stages: StageStanding[];                   // every current stage, including the empty ones
  unsorted: number;                          // leads nobody has triaged
  total: number;                             // every conversation of the agent
  stageHistorySince: string;                 // ISO — when the funnel began recording
}

interface FunnelStep { stageId; name; kind: StageKind; position; entered: number;
                       conversion: number | null }   // share of the previous step, 0..1
interface StatsSource {
  sourceId: string | null;                   // null: a click with no ad id behind it
  sourceType: string | null;
  headline: string | null;
  leads: number; withClickId: number; won: number;
  paidTotal: string;
}
interface StatsMoney {
  paidOrders: number; paidTotal: string;
  averageOrder: string | null; revenuePerLead: string | null;
  otherCurrencyOrders: number;
}
interface StatsPeriodReport {
  period: Period; since: string; stageHistorySince: string;
  funnel: FunnelStep[];                      // empty exactly when nothing moved
  failureEntries: number; backwardMoves: number; deletedStageEntries: number;
  deletedStageNames: string[];
  newLeads: number; leadsFromAds: number;    // conversations created in the window
  sources: StatsSource[];
  money: StatsMoney | null;                  // null exactly when no paid order in the window
  currency: string;
}
```

`money: null` rather than a row of zeros is `AiUsage.total`'s rule, for `AiUsage.total`'s
reason.

## Sources

Grouped by `conversations.ad_source_id` over conversations **created in the window** — the
click happened then, and cohorting by creation is what makes two periods comparable.
Conversations carrying a `ctwa_clid` with no `ad_source_id` collapse into one row with
`sourceId: null`; conversations with neither are not sources at all and are the difference
between `newLeads` and `leadsFromAds`.

`won` is the count now standing in a stage of kind `success` — a fact about the present,
available for every lead, not a transition. `paidTotal` is **every** paid order of those
conversations, whenever it was paid, so a lead who clicked in the window and paid a month
later still credits the ad that brought them. That makes a past period's figure grow after
the fact, which is correct for attribution and is said on the card in words.

## The screen

`/a/:agentId/stats`, three cards, in this order. `AgentScreen`'s tokens, `Segmented`,
`Async`, `EmptyState`, `Stat`; no new component library and no new dependency.

**1. «Сейчас в воронке» — no period control.** The absence of the control is the point: this
is a snapshot of now, over every lead the cabinet has ever had, and it cannot be asked about
last week. A bar per stage with its colour and count, `unsorted` first and never hidden.
Sub-title: «Снимок на сейчас. Считаются все диалоги агента, включая заведённые до этапа 7.»

**2. «Движение по воронке» — period control.** Steps with `entered` and the conversion to the
next, `backwardMoves`, `failureEntries`, and `deletedStageEntries` when it is not zero.
Directly under the title, always: «Переходы записываются с 3 сентября 2026.» And when the
selected period starts before that date, a band the owner cannot miss: «Период начинается
раньше, чем кабинет начал записывать переходы. Всё, что было до 3 сентября, здесь не
учтено — сколько лидов где стоит сейчас, показывает карточка выше.»

The two cards are never both called «воронка» on their own — one is «Сейчас в воронке», the
other «Движение по воронке» — and they carry different controls and different date lines.

**3. «Источники и деньги» — the same period control.** A row per source with leads, clicks
with an id, sales and money; the money tiles beside it. Sub-title: «Считается по всем
диалогам, начавшимся за период. Деньги — по всем их оплатам, даже если оплата пришла позже.»

### The empty cabinet

Every card says which absence it is looking at. None of them prints a zero for it.

| State | What the card says |
|---|---|
| No conversations at all | «Диалогов ещё нет. Статистика появится, когда клиент напишет в WhatsApp.» |
| Conversations, none triaged | «Ни один диалог ещё не разобран по стадиям — все лиды в «Без стадии».» |
| Funnel, no transitions in the period | «За этот период лидов по воронке не двигали. Переходы записываются с 3 сентября — всё, что было раньше, в этой карточке не учтено.» |
| Funnel, period predates the stamp | The band above, in addition. |
| Sources, no ad-sourced threads | «Ни один диалог за период не пришёл с рекламы. Сюда попадают только переходы по Click-to-WhatsApp.» |
| Money, no paid orders | «За период нет оплаченных заказов. Заказ попадает сюда, когда его отмечают оплаченным в карточке лида.» |

## Testing

Server, vitest against the real test database, one per agent through `TEST_DATABASE_URL`:

- The table: a stage delete leaves the row with `to_stage_id` null and the snapshot name
  intact; a conversation delete removes its rows; `stage_history_since` is non-null on every
  agent after the migration.
- The writers: an operator move writes one row with `operator` and the user id; the agent's
  move writes `ai`; a lost race writes none; a first stage writes `from_stage_id` null; a
  sandbox turn writes none; a move to the same stage writes none.
- The snapshot: every current stage appears including the empty ones, `unsorted` is separate,
  another agent's conversations are absent, a 404 for an agent the caller does not belong to.
- The period report: conversion null on the first step and on a zero denominator; a lead that
  entered a stage twice counted once; a backwards move counted in both the stage and
  `backwardMoves`; a `failure` stage out of the chain; a deleted stage's entries counted and
  named; money summed exactly for an amount a double cannot hold; `money` null when nothing
  was paid; an order in another currency excluded and counted; a source's money including an
  order paid after the window.

Frontend: `npm --prefix rakurs run typecheck` and `run build`. There are no frontend tests and
this stage does not add a framework for them.

## Out of scope

- **Charts drawn with a charting library.** No new frontend dependency. Bars are divs with a
  width; that is the whole of the drawing this screen needs.
- **CSV export of statistics.** The board already exports leads, which is the export people
  actually ask for; a second export of aggregates has no reader yet.
- **Per-operator performance ranking.** `moved_by_user_id` is recorded so it stays possible,
  but a leaderboard is a management decision with consequences for people, and it is not
  something to ship as a side effect of counting a funnel.
- Time spent in a stage and time to a sale. Computable from `stage_transitions` once it has
  months in it. Not on the day the table is empty.
- Comparing one period against the previous one, and any scheduled report by email.
