# Vault Knowledge Base Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The tasks live in the three part files below; read this header and **Global Constraints** first, then open the part you are on.

**Goal:** Replace the flat `kb_items` store with markdown notes in folders, linked by `[[wiki links]]`, from which the agent retrieves a *section* rather than a whole record.

**Architecture:** A note (`kb_notes`) is what a person writes. Sections (`kb_chunks`) are derived from it on every save by one pure splitter and are the only thing search reads. Links (`kb_links`) are parsed on the same save and resolved by title. `searchKnowledge` keeps its signature and changes table.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` import specifiers), Fastify 5, Drizzle ORM + drizzle-kit, Postgres full-text search (`russian`), Vitest, React 19 + Vite.

**Spec:** [docs/superpowers/specs/2026-09-08-obsidian-knowledge-base-design.md](../specs/2026-09-08-obsidian-knowledge-base-design.md)

## Global Constraints

- Everything written into the repository is English: identifiers, comments, commit messages, test names. UI strings stay Russian — the sellers are Russian-speaking.
- Column limits, already in `server/src/lib/knowledge/split.ts`: `TITLE_MAX = 200`, `CONTENT_MAX = 8000`. A note body is capped at `BODY_MAX = 200_000`.
- Retrieval limits do not change: `KNOWLEDGE_LIMIT = 6` (agent), `SEARCH_LIMIT = 20`, `LIST_LIMIT = 100`.
- `kb_chunks` is derived. No route inserts one; only `saveNote` writes the table.
- Tenancy: every query reaches a note through `agentId`. Notes are writable by any member; sources stay owner-only.
- Tests run against Postgres: `TEST_DATABASE_URL`, default `postgres://rakurs:rakurs@localhost:55432/rakurs_test`. Run from `server/`: `npm test`.
- Every new table must be added to the `truncate` list in `server/test/helpers/db.ts`, or later tests inherit rows.

## The parts

Work them in order — each one leaves the suite green, and each later part consumes names the earlier one produced.

| Part | Tasks | What it leaves working |
|---|---|---|
| [Part 1: the store](2026-09-08-vault-knowledge-base-store.md) | 1–3: the section splitter, the link parser, the schema and migration `0012` | Notes, sections and links exist and the old records have moved into them. |
| [Part 2: saving and search](2026-09-08-vault-knowledge-base-save.md) | 4–5: `saveNote`, search over sections | A note save derives its sections and links, and the ranker the agent shares runs on sections. |
| [Part 3: the note routes](2026-09-08-vault-knowledge-base-routes.md) | 6–7: the contract types, the note routes | The cabinet reads and writes notes, backlinks and the graph over HTTP. |
| [Part 4: imports, the agent and the screens](2026-09-08-vault-knowledge-base-screens.md) | 8–12: imports writing notes, the turn quoting sections, the three-pane screen, the graph, the owner's docs | The whole feature, as an owner meets it. |

## Done when

`npm test` passes in `server/`, `npm run build` and `npx vitest run` pass in `rakurs/`, `kb_items` appears nowhere outside the `0012` migration, and a note written with two headings answers two different customer questions with two different sections.
