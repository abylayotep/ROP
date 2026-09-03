# Task 1 — The transitions table and the recording point

**Status:** done. `a818640` — "Start recording stage movement, and remember the day it started",
on branch `claude/stats`.

## What was built

### `server/src/db/schema.ts`

- **`stageTransitions`**, placed between `orders` and `notes`, with exactly the columns and the
  two indexes the plan specifies. The doc comment carries the three things the plan asked for:
  that the table is append-only and a correction is the next move rather than a rewrite; why a
  stage is stored twice, as an id the funnel joins on and as a name/kind/position snapshot that
  survives the stage being deleted; and why `conversation_id` cascades where
  `capi_events.conversation_id` nulls — the funnel counts distinct conversations, and a row with
  no conversation cannot be counted distinctly without inventing an identity for it.
- **`agents.stageHistorySince`** — `timestamptz not null default now()`, commented as the instant
  the agent began recording movement, with the note that everything before it is unrecoverable
  and that the screen names the date rather than letting an owner assume the funnel covers their
  whole history.

Nothing else in `schema.ts` changed.

### `server/drizzle/0011_long_jack_power.sql`

Generated with `npm --prefix server run generate`. **The generated SQL was not edited**, only
prefixed with a header comment in the style of `0005_seed_default_funnel.sql`. The generator
emitted exactly what the plan predicted for the new column:

```sql
ALTER TABLE "agents" ADD COLUMN "stage_history_since" timestamp with time zone DEFAULT now() NOT NULL;
```

### What an existing agent gets, and why

**The migration's own `now()`.** Postgres, adding a `NOT NULL DEFAULT now()` column, writes the
default into every row that already exists, so an agent the cabinet has been running for months
is stamped with the instant `0011` ran. That is the honest answer and the only one available:
the moment recording begins *is* the moment the migration runs, and nothing earlier can be
claimed because no earlier movement was ever stored. The alternative — leaving the column
nullable and letting the application fill it later — would give the screen a null to render on
the day of the deploy, which is precisely the state that makes the funnel imply it covers the
past. The decision lives in the DDL, not in the application.

Verified against a scratch database rather than argued: a database migrated to `0010`, given an
account, an agent with `created_at = now() - interval '6 months'`, a stage, a contact, a number,
a conversation and a paid order, then migrated to `0011`. The six-month-old agent came out with
`stage_history_since` non-null and inside a minute of `now()`. The same scratch run confirms the
migration applies cleanly to an empty database as well. Both probe databases were dropped.

### `server/test/stats-schema.test.ts`

Nine cases, alongside `orders-schema.test.ts`:

1. A move stores and reads back every column, ids and snapshot together.
2. A first move takes `now()` and leaves both `from` columns and `moved_by_user_id` null.
3. Deleting the stage a move went **to** leaves the row, `to_stage_id` null, `to_name`,
   `to_kind` and `to_position` unchanged.
4. The same for the stage a move came **from**.
5. Deleting a conversation deletes its moves.
6. Deleting an agent deletes its moves.
7. Deleting the employee who made a move leaves the row with `moved_by_user_id` null.
8. A new agent is stamped with a `stage_history_since` inside the last minute.
9. No agent is left without one: `information_schema` says the column is `NOT NULL` with default
   `now()`, which is the mechanism that stamps rows predating it, and no row is null.

Case 9 asserts the *shape* of the column rather than rows that predate the migration, because the
test harness migrates once and truncates per test — a freshly migrated database has no such rows
to look at. The precedent is `knowledge-page.test.ts`, which checks `kb_sources.status` has no
default the same way. The behaviour on real pre-existing rows is covered by the scratch-database
run described above; reproducing it inside the suite would mean dropping and re-adding a column
on a database shared by parallel vitest workers, which risks blocking or deadlocking unrelated
test files for the sake of restating what Postgres guarantees.

## Verification

| | |
|---|---|
| `npm --prefix server test` | **758 passed, 47 files** (749 before, plus these 9) |
| `npm --prefix server run typecheck` | see the caveat below |
| Migration on a populated database | applied, six-month-old agent stamped |
| Migration on an empty database | applied |
| Writers to `stage_transitions` | none — this task adds the shape, not the writer |

### Caveat: a second agent is working in this same worktree

`git status` shows uncommitted work belonging to **task 3** in this worktree —
`server/src/lib/period.ts`, `server/src/api/stats.ts`, `server/test/stats-current.test.ts`, and
edits to `packages/contract/index.ts`, `server/src/api/ai.ts`, `server/src/api/server.ts` and
`rakurs/src/api/index.ts`. That work is mid-flight, and `tsc --noEmit` currently reports four
errors, all inside those two new files (`Period`, `StatsCurrent` and `StageStanding` are not yet
exported from the contract; one `noUncheckedIndexedAccess` index in `period.ts:39`). **None of
them is in a file this task touched**, and the suite is green because the half-finished endpoint
is not yet mounted in a way the tests exercise.

The commit therefore stages paths explicitly rather than `git add -A`: only `schema.ts`, the
migration, its snapshot, the journal entry and the new test file. Nothing of task 3's is in it.

This report file is deliberately left untracked, so the acceptance criterion — nothing outside
`schema.ts`, the migration and the new test changed — holds for the commit.
