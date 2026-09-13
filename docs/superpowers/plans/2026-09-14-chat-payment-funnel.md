# Chat Payment Funnel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Started on: Opus 5 · Subtasks: Opus 5 (high) — the session model governs every subagent.

**Goal:** Merge «Заказано» into «Оплачено», let the CRM analysis move a lead into the sale stage when the chat shows payment, and record a paid order plus `Purchase` from the amount the seller quoted.

**Architecture:** The stage kind `awaiting_payment` disappears (contract, API, cabinet, default funnel, data migration). `lib/crm/analysis.ts` gains a grounded `paid` payment state and a grounded `paidAmount`; `lib/crm/worker.ts` uses them to move the lead and to insert one chat order, then calls the existing `queuePurchase`. The Kaspi-only gates in the operator move and the live reply agent go.

**Tech Stack:** TypeScript, Fastify, Drizzle ORM on Postgres, Zod, Vitest, React (cabinet `rakurs/`).

**Spec:** `docs/superpowers/specs/2026-09-14-chat-payment-funnel-design.md`

## Global Constraints

- Code, comments, tests, commits in English. User-facing strings in Russian.
- Match the surrounding code style of each file (several files are dense one-liners; keep them so).
- Sale stage = the one stage with `kind = 'success'`. Never create a second one.
- Chat order: `status = 'paid'`, `currency = agent.currency`, `comment = 'Оплата по переписке'`, `paidAt = conversations.stage_set_at`.
- Payment confidence threshold for moving: `confidence >= 65` (same as the existing stage threshold).
- New migration: `server/drizzle/0046_merge_awaiting_payment.sql`, journal entry `idx 46`, `when 1789295400000`. Never edit earlier migrations or journal entries.
- Test environment (every task): test DB is Docker (`docker compose -f deploy/compose.test.yml up -d`, port 55432, needs colima running). The Bash sandbox blocks localhost TCP, so every vitest run needs `dangerouslyDisableSandbox: true`; `connect EPERM 127.0.0.1:55432` means sandbox, not a dead DB. `npm install` in a fresh worktree needs `--cache "$TMPDIR/npm-cache"`. `capi-queue`, `session`, `whatsapp-inbound`, `knowledge-import-text` fail intermittently; rerun before investigating.
- Commit messages end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.


## Task files

Each file is self-contained; open only the one for the task at hand.

| Task | File | What |
|---|---|---|
| 1 | `2026-09-14-chat-payment-funnel-task-1-2.md` | Remove the `awaiting_payment` stage kind (contract, API, default funnel, cabinet, tests) |
| 2 | `2026-09-14-chat-payment-funnel-task-1-2.md` | Migration 0046 merges existing `awaiting_payment` stages into the sale stage |
| 3 | `2026-09-14-chat-payment-funnel-task-3.md` | Grounded `paid` payment state, `paidAmount`, new `resolveCrmStage`, prompt |
| 4 | `2026-09-14-chat-payment-funnel-task-4-5.md` | Worker moves paid chats, records the chat order + `Purchase`; Kaspi gates removed |
| 5 | `2026-09-14-chat-payment-funnel-task-4-5.md` | Orders list includes chat orders; cabinet labels |

Order: 1 → 2 → 3 → 4 → 5. Task 4 depends on Task 3's interfaces.

## After the tasks

- Full `server` suite + cabinet type check once more on the final branch.
- Push the branch and open a PR. Release to production goes through `deploy/release.sh` from `origin/main` only after the owner approves the merge.
- After release, check on production: no `awaiting_payment` stages, the 20 leads in «Оплачено», their `crm_analyses` drained, and how many got a chat order. The CRM worker only drains conversations its mode allows (`independent`, or `follow_ai` with AI on and live mode) — if the agent is not eligible, report it rather than changing the mode.
