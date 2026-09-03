# Orders and Funnel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the stream of WhatsApp conversations into a funnel: a board of stages, a lead card beside each thread, orders that carry the money, and a table of every customer.

**Architecture:** A conversation gains a stage, an assignee and custom field values; money lives in a separate `orders` table so a repeat purchase is a second row rather than an overwrite. The stage set is per agent, seeded with a default funnel, and the server enforces exactly one stage of kind `success`. Entering a stage may fire a template through the same Graph client interface stage 2 introduced, which the tests replace with a fake.

**Tech Stack:** Fastify 5, Drizzle ORM 0.45 + drizzle-kit, PostgreSQL, Zod 4, Vitest 4 · React 18, Vite 5, react-router-dom 6.

**Spec:** [`docs/superpowers/specs/2026-09-03-orders-funnel-design.md`](../specs/2026-09-03-orders-funnel-design.md)

## Global Constraints

- **Language.** Code, comments, commit messages and docs in English. Every string a user reads stays Russian — the frontend renders a server error's `message` verbatim.
- **Commands run from the repository root:** `npm --prefix server …`, `npm --prefix rakurs …`.
- **Server tests need the test database** on port 55432 (`docker compose -f deploy/compose.test.yml up -d`). A refused localhost connection reported as `connect EPERM` is the sandbox, not a broken test.
- **No test may reach the network.** The Graph client is an interface; tests inject `fakeGraph()` from `server/test/helpers/fake-graph.ts`.
- **No fixtures and no invented data.** A screen with no endpoint behind it says so.
- **Role vocabulary:** `owner` and `member`, spelled exactly that way. Editing the stage set and the lead fields is owner-only; moving a lead, writing notes and recording an order is open to any member.
- **An agent or a record the caller does not belong to answers 404, never 403.** 403 is only the answer after membership is proven. The guard is `requireAgent(db, { role: 'owner' }?)` from `server/src/api/require-agent.ts`.
- **Any id taken from a URL is checked with `isUuid()`** (`server/src/lib/uuid.ts`) before it reaches a query. Comparing non-UUID text against a `uuid` column makes Postgres raise, which turns a typo into a 500 instead of a 404.
- **Stage kinds are exactly** `active`, `qualified`, `awaiting_payment`, `success`, `failure`.
- **Lead field kinds are exactly** `text`, `number`, `date`. **Order statuses are exactly** `pending`, `paid`, `cancelled`.
- **Money is `numeric(14,2)`** in Postgres and a **string** in the contract and in the browser. Formatting is the screen's job; no float ever holds an amount.
- **Every new table carries `agent_id`** and reaches the account through the agent, except `lead_values` and `notes`, which reach it through their conversation.
- **A new table must be added to the `truncate` list** in `server/test/helpers/db.ts`, or every later suite leaks rows into the next.

## File structure

| File | Responsibility |
|---|---|
| `server/src/db/schema.ts` | Five new tables and the new columns on `conversations` and `agents`. |
| `server/src/lib/funnel.ts` | The default funnel and the routine that seeds it for a new agent. |
| `server/src/lib/funnel-message.ts` | Rendering a stage template and sending it, or recording why it was not sent. |
| `server/src/api/stages.ts` | Stage and lead-field settings, owner-only. |
| `server/src/api/leads.ts` | The lead: stage, assignee, field values, notes, and the account's members. |
| `server/src/api/orders.ts` | Orders on a conversation. |
| `server/src/api/board.ts` | The board and the customers table, including the CSV export. |
| `rakurs/src/screens/BoardScreen.tsx` | The kanban with drag and drop. |
| `rakurs/src/screens/CustomersScreen.tsx` | The customers table and its export. |
| `rakurs/src/components/lead/LeadPanel.tsx` | The panel beside a thread. |
| `rakurs/src/components/lead/OrderDialog.tsx` | The order form, opened from the panel and from the board. |
| `rakurs/src/screens/FunnelSettings.tsx` | The stage and lead-field editors, mounted under Настройки. |
| `packages/contract/index.ts` | The types both sides read. |

## Tasks

Each task ends green: `npm --prefix server test`, `npm --prefix server run typecheck`, and for any task touching `rakurs/`, `npm --prefix rakurs run typecheck` and `npm --prefix rakurs run build`.

| # | Task | File |
|---|---|---|
| 1 | Schema and migration | [task-1-schema.md](2026-09-03-orders-task-1-schema.md) |
| 2 | Seeding the default funnel | [task-2-seed.md](2026-09-03-orders-task-2-seed.md) |
| 3 | Stages and lead fields over the API | [task-3-stages-api.md](2026-09-03-orders-task-3-stages-api.md), [its test file](2026-09-03-orders-task-3-stages-test.md) |
| 4 | The lead: stage, assignee, values, notes | [task-4-lead-api.md](2026-09-03-orders-task-4-lead-api.md), [its test file](2026-09-03-orders-task-4-lead-test.md) |
| 5 | The auto-message on entering a stage | [task-5-auto-message.md](2026-09-03-orders-task-5-auto-message.md) |
| 6 | Orders | [task-6-orders-api.md](2026-09-03-orders-task-6-orders-api.md) |
| 7 | The board and the customers table | [task-7-board-api.md](2026-09-03-orders-task-7-board-api.md), [its test file](2026-09-03-orders-task-7-board-test.md) |
| 8 | The board screen | [task-8-board-screen.md](2026-09-03-orders-task-8-board-screen.md) |
| 9 | The lead panel | [task-9-lead-panel.md](2026-09-03-orders-task-9-lead-panel.md), [the order dialog](2026-09-03-orders-task-9-order-dialog.md) |
| 10 | The customers screen | [task-10-customers-screen.md](2026-09-03-orders-task-10-customers-screen.md) |
| 11 | The funnel editors and the documentation | [task-11-settings-docs.md](2026-09-03-orders-task-11-settings-docs.md), [the editors](2026-09-03-orders-task-11-editors.md) |

Tasks 1 to 7 are the server and need no browser. Task 4 produces the lead endpoint tasks 8 and 9 read, and task 5 changes the route task 4 wrote — task 5 therefore lands after it, never beside it.

Five tasks keep a long code block in a sibling document so that neither crosses the
five-hundred-line limit this repository keeps. An implementer working one of those tasks is
given both paths.

## Definition of done

- A new agent arrives with nine stages, one of them the sale.
- A second stage of kind `success` is refused, and so is removing the only one.
- A stage still holding conversations refuses to be deleted and says how many are in it.
- Moving a lead records who moved it and when.
- Entering a stage that carries a template sends the message when the window is open, and writes a note saying why when it is closed. The first stage a lead is ever given sends nothing.
- An order marked paid stamps `paid_at`; the board and the customers table count only paid orders.
- A lead, a field, a note or an order belonging to another agent answers 404.
- A card can be dragged between columns and the move survives a reload.
- The customers table exports a CSV that opens in Excel with Russian text intact.
- No test reaches the network.
