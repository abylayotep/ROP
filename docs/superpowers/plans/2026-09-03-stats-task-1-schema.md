# Task 1 — The transitions table and the recording point

**Depends on:** nothing.
**Blocks:** task 2 (nothing to write to), task 4 (nothing to read from).

## Why

`conversations` keeps the last stage a lead was put in and nothing else. Every question this
stage asks about movement needs a row per move, and there is nothing to derive one from.
Alongside it, the cabinet has to remember the instant recording began, so the screen can name
a date instead of implying that the numbers cover the past.

## Steps

- [ ] Add `stageTransitions` to `server/src/db/schema.ts`, after `orders` and before `notes`:

```
id               uuid pk defaultRandom
agentId          uuid not null → agents        onDelete cascade
conversationId   uuid not null → conversations onDelete cascade
fromStageId      uuid null     → stages        onDelete set null
toStageId        uuid null     → stages        onDelete set null
fromName         text null      -- snapshot of the stage's name at the move
toName           text not null
toKind           text not null  -- 'active'|'qualified'|'awaiting_payment'|'success'|'failure'
fromPosition     int  null
toPosition       int  not null
movedBy          text not null  -- 'operator'|'ai'|'scenario'|'system'
movedByUserId    uuid null     → users         onDelete set null
occurredAt       timestamptz not null defaultNow
index stage_transitions_agent_occurred_idx  (agentId, occurredAt)
index stage_transitions_conversation_idx    (conversationId, occurredAt)
```

- [ ] Comment the table the way `capiEvents` is commented. Three things earn a comment:
  - **Append-only.** Nothing updates or deletes a row here; a correction is a new move.
  - **Why both the id and the snapshot.** An owner may delete a stage once it is empty, and
    `set null` alone would erase which stage a lead passed through. The snapshot keeps the row
    readable; the id is what the funnel joins on while the stage still exists.
  - **Why `conversationId` cascades** while `capi_events.conversation_id` nulls: the funnel
    counts distinct conversations, and a row with no conversation cannot be counted distinctly
    without inventing an identity. A report sent to Meta is a fact about the outside world; a
    row here is an input to our own arithmetic.
- [ ] Add `stageHistorySince: timestamp({ withTimezone: true }).notNull().defaultNow()` to
  `agents`, commented as: the instant this agent began recording movement. Everything before
  it is unrecorded and unrecoverable, and the screen names this date rather than letting an
  owner assume the funnel covers their whole history.
- [ ] Generate the migration with drizzle-kit (`npm --prefix server run generate` or whatever
  `package.json` names it) — do not hand-write the DDL. It becomes `server/drizzle/0011_*.sql`.
- [ ] Check the generated SQL: adding a `not null default now()` column to `agents` stamps
  every existing row at the migration's `now()`, which is exactly the intent. If drizzle-kit
  emits anything else, fix the schema, not the SQL.
- [ ] Add a header comment to the generated file, in the style of `0005_seed_default_funnel.sql`:
  this migration is the moment the funnel starts, `stage_history_since` records it per agent,
  and nothing backfills `stage_transitions` because there is no honest source — see the spec.
- [ ] Tests in `server/test/stats-schema.test.ts`, alongside `orders-schema.test.ts`:
  - A row inserts and reads back with every column.
  - Deleting a stage that a transition points at leaves the row, with `to_stage_id` null and
    `to_name`, `to_kind`, `to_position` unchanged.
  - Deleting a conversation removes its transitions.
  - Deleting an agent removes them.
  - Deleting the user who made a move leaves the row with `moved_by_user_id` null.
  - Every agent created before the migration has a non-null `stage_history_since`. Assert it
    against a freshly migrated database: the test helper migrates, so `now()` is recent.

## Acceptance criteria

- [ ] `npm --prefix server test` and `npm --prefix server run typecheck` are green.
- [ ] The migration applies to a database that already has stages, conversations and orders,
  and applies to an empty one.
- [ ] No code writes to `stage_transitions` yet. This task adds the shape, not the writer.
- [ ] Nothing outside `schema.ts`, the migration and the new test file changed.

## Before task 2 starts

The table exists with the foreign-key behaviours above proven by tests, and every agent —
including the one the product actually runs on — carries a `stage_history_since`.
