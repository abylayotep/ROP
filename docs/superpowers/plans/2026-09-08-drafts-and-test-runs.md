# Drafts and Test Runs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The tasks live in the two part files below; read this header and **Global Constraints** first.

**Goal:** Nothing the coach proposes reaches the store the agent answers from until it has been replayed against real conversations and a person has looked at the result.

**Architecture:** A change becomes a `kb_draft` holding a list of operations and the `updatedAt` of everything it touches. A run applies those operations inside the sandbox's rolled-back transaction and replays a set of saved customer conversations through `runTurn`. «Было» is a run of the same cases with no draft, cached by the agent's `config_version`, so a second run pays for one half of the table instead of two. The owner reads the comparison and presses «Применить», which re-checks that nothing moved underneath the draft.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` import specifiers), Fastify 5, Drizzle ORM + drizzle-kit, OpenRouter, zod, Vitest, React 19 + Vite.

**Spec:** [docs/superpowers/specs/2026-09-08-drafts-and-test-runs-design.md](../specs/2026-09-08-drafts-and-test-runs-design.md)

**Depends on:** [the vault plan](2026-09-08-vault-knowledge-base.md) and [the coaching plan](2026-09-08-agent-coaching.md). The operations a draft applies are note saves and rule writes; the proposals it wraps come from the coach.

## Global Constraints

- Everything written into the repository is English: identifiers, comments, commit messages, test names. UI strings stay Russian.
- A run must leave the database exactly as it found it. The rollback is the mechanism; a `finally` that deletes is not.
- One draft holds one change from the coach. `ops` is a list because applying one and applying three is the same code.
- A draft may be applied only after a finished run **at the agent's current `config_version`**, and only if nothing it touches has moved since it was made.
- Limits, matching the sandbox: 20 cases per run, three runs in flight per account, 20 runs a minute, a case message at most 4000 characters, at most 10 messages per case.
- Every model call costs the owner money and the screen states the arithmetic before spending it.
- Drafts, runs and cases are owner-only.
- Tests run against Postgres: `TEST_DATABASE_URL`, default `postgres://rakurs:rakurs@localhost:55432/rakurs_test`. Run from `server/`: `npm test`. No test may reach the network.
- New tables go into the `truncate` list in `server/test/helpers/db.ts`.

## The parts

| Part | Tasks | What it leaves working |
|---|---|---|
| [Part 1: the store and the operations](2026-09-08-drafts-schema.md) | 1–3: schema and migration `0014`, the config version, applying a draft's operations | A draft exists, and what the agent would say is versioned. |
| [Part 2: replaying and running](2026-09-08-drafts-runs.md) | 4–6: replaying a case, the baseline, the run route | A draft can be run and the comparison read over HTTP. |
| [Part 3: judging and applying](2026-09-08-drafts-and-test-runs-screens.md) | 7–12: the annotation, apply and discard, the case set, the contract, the screens, the owner's docs | The whole loop: propose, draft, run, compare, push. |

## Done when

`npm test` passes in `server/`, `npm run build` passes in `rakurs/`, a run leaves the store byte-identical, and a draft made before someone edited the note it touches refuses to apply with words the owner can act on.
