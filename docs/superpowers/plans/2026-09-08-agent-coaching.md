# Agent Coaching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The tasks live in the two part files below; read this header and **Global Constraints** first.

**Goal:** Replace the 20 000-character instructions field with a list of rules the owner dictates in a coaching chat, where the model proposes and the owner decides, and where a fact is pushed into the knowledge base instead of into instructions.

**Architecture:** `agent_rules` holds one behaviour rule per row, grouped by category. `instructionsSection` assembles the enabled rules into the same string the prompt already carried, so the number guard keeps working unchanged. The coach is a model call returning a message plus at most one structured proposal; a proposal writes nothing — it becomes a draft, which the drafts plan owns.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` import specifiers), Fastify 5, Drizzle ORM + drizzle-kit, OpenRouter through `server/src/lib/ai/openrouter.ts`, zod, Vitest, React 19 + Vite.

**Spec:** [docs/superpowers/specs/2026-09-08-agent-coaching-design.md](../specs/2026-09-08-agent-coaching-design.md)

**Depends on:** [the vault plan](2026-09-08-vault-knowledge-base.md) — the fact check searches notes, and a note proposal is a path and a body.

## Global Constraints

- Everything written into the repository is English: identifiers, comments, commit messages, test names. UI strings and the coach's own system prompt stay Russian.
- `agent_rules.text` is capped at 500 characters. Four categories only: `business`, `tone`, `order`, `forbid`.
- The coach never writes to `agent_rules`, `kb_notes` or `kb_chunks`. Its only write is a `coach_messages` row. Creating a rule by hand is a different route.
- Rules and the coach are owner-only. Notes stay writable by any member.
- Every model call costs the owner money and must be rate-limited the way the sandbox is: three in flight, 20 a minute.
- Tests run against Postgres: `TEST_DATABASE_URL`, default `postgres://rakurs:rakurs@localhost:55432/rakurs_test`. Run from `server/`: `npm test`.
- New tables go into the `truncate` list in `server/test/helpers/db.ts`.
- No test may reach the network. The model client is faked the way `server/test/helpers/` already fakes Graph.

## The parts

| Part | Tasks | What it leaves working |
|---|---|---|
| [Part 1: the rules](2026-09-08-agent-coaching-rules.md) | 1–3: schema and migration `0013`, the prompt assembled from rules, the rules routes | The agent's character is a list of rules, and the old instructions field is gone. |
| [Part 2: the coach](2026-09-08-agent-coaching-chat.md) | 4–6: the coach call, the fact check, the coach routes | The owner dictates a change and gets a proposal back, and nothing is written. |
| [Part 3: the screens](2026-09-08-agent-coaching-screens.md) | 7–11: contract types, the coaching screen, the settings screen, the dialog button, the owner's docs | The owner coaches the agent from the cabinet and from a live dialog. |

## Done when

`npm test` passes in `server/`, `npm run build` passes in `rakurs/`, `agents.instructions` exists nowhere outside migration `0013`, and a sentence typed into the coach about a price comes back as a note proposal rather than a rule.
