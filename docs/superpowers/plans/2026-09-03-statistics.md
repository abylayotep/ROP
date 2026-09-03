# Statistics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show an owner where leads stop moving, which ads bring the ones who pay, and how much came in — without claiming to know anything the cabinet never recorded.

**Architecture:** Stage movement has never been stored, so an append-only `stage_transitions` table starts recording it on the day this migration runs, and `agents.stage_history_since` remembers which day that was. Two endpoints, deliberately not one: a snapshot of where every lead stands now, which has no period, and a period report — funnel, sources, money — which does. The screen mirrors the split so the number that is honest about the past is never read as the one that starts today.

**Tech Stack:** Fastify 5, Drizzle ORM 0.45 + drizzle-kit, PostgreSQL 17, Zod 4, Vitest 4 · React 18, Vite 5.

**Spec:** [`docs/superpowers/specs/2026-09-03-statistics-design.md`](../specs/2026-09-03-statistics-design.md)

## Global Constraints

- **Language.** Code, comments, identifiers, commit messages and docs in English. Every string a user reads stays Russian.
- **Commands run from the repository root:** `npm --prefix server …`, `npm --prefix rakurs …`.
- **Each agent gets its own test database** through `TEST_DATABASE_URL`; a shared one deadlocks when two runs overlap.
- **Nothing is backfilled into `stage_transitions`.** There is no honest source for it, and a synthetic row per conversation would print conversions above 100%. The spec says why; do not reopen it in code.
- **Money never passes through a JavaScript number.** Summed and rounded in Postgres, cast `::numeric(16,2)::text`, typed `string` in the contract, formatted by string replacement on the screen. No `Number()`, no `toLocaleString` on an amount.
- **A count of nothing is `null` in the response, not `0`,** wherever zero would read as a fact. `AiUsage.total` is the precedent.
- **`noUncheckedIndexedAccess` is on.** An aggregate that returns exactly one row still needs `rows[0]!`, and the `!` is worth a word saying why the row is certain.
- **The transition is written inside the transaction that moved the stage.** If it cannot be written, the move fails. This is the opposite of the CAPI hook's swallow-and-continue, and on purpose: that one talks to Meta, this one is an insert into our own table.
- **Only a guarded `UPDATE` that returned a row records a move.** A request that lost the race changed nothing.
- **Role vocabulary:** `owner` and `member`. Both statistics endpoints are open to any member.
- **An agent the caller does not belong to answers 404, never 403.**
- **No new frontend dependency,** and no test framework for the frontend.

## File structure

| File | Responsibility |
|---|---|
| `server/src/db/schema.ts` | `stage_transitions`, and `stage_history_since` on `agents`. |
| `server/src/lib/funnel-history.ts` | `recordStageMove` — the one writer both move paths call. |
| `server/src/lib/period.ts` | The three periods, their windows, and their query parser. Shared with `api/ai.ts`. |
| `server/src/api/stats.ts` | The snapshot and the period report. |
| `rakurs/src/screens/StatsScreen.tsx` | Three cards: standing now, movement, sources and money. |
| `packages/contract/index.ts` | `Period`, `StatsCurrent`, `StatsPeriodReport` and their parts. |
| `docs/statistics.md` | What the numbers mean and which of them start today. |

## Tasks

Each task ends green: `npm --prefix server test`, `npm --prefix server run typecheck`, and for any task touching `rakurs/`, `npm --prefix rakurs run typecheck` and `npm --prefix rakurs run build`.

| # | Task | File |
|---|---|---|
| 1 | The transitions table and the recording point | [task-1-schema.md](2026-09-03-stats-task-1-schema.md) |
| 2 | Record every move | [task-2-record.md](2026-09-03-stats-task-2-record.md) |
| 3 | The shared period, and the snapshot endpoint | [task-3-period-current.md](2026-09-03-stats-task-3-period-current.md) |
| 4 | The period report: funnel, sources, money | [task-4-period-report.md](2026-09-03-stats-task-4-period-report.md) |
| 5 | The screen | [task-5-screen.md](2026-09-03-stats-task-5-screen.md) |
| 6 | Documentation | [task-6-docs.md](2026-09-03-stats-task-6-docs.md) |

Order is not negotiable at the seams. Task 1 creates the table task 2 writes to. Task 2 must
land before task 4, or the funnel query is tested against rows no code produces. Task 3
extracts the period module task 4 imports, and its endpoint is the one the screen's first
card reads. Task 5 needs both endpoints to exist. Task 6 needs the screen, because it
describes what an owner sees.

Tasks 1 and 3 touch nothing the other touches and may be done in either order; everything
else is a chain.

## Definition of done

- Every stage move — operator, agent, and any writer added later — leaves exactly one row, with who moved it, from where, and when.
- A move that lost its race, a move to the stage the lead is already in, and a sandbox turn leave none.
- The snapshot counts every lead the cabinet has, including those triaged before this stage shipped, and never confuses that with the funnel.
- The funnel counts a lead once per stage, keeps a `failure` stage out of the chain, and reports a conversion of `null` — never `0%` — where there is nothing to divide by.
- The funnel names the date it began recording, and warns when the chosen period starts before it.
- Sources are honest about the past: every thread that arrived from a click is counted, back to the day the number was connected.
- Every money figure is exact to the cent and reaches the browser as characters.
- Every empty card says what is missing in Russian; none of them shows a zero instead.
- README's roadmap says stage 7 is готово, and `docs/statistics.md` says plainly which numbers start today.
