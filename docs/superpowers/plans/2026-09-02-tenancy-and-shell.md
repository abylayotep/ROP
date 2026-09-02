# Tenancy and Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the single-company cabinet into an account → agents workspace and replace the seven prototype screens with the navigation the new product needs.

**Architecture:** Three new tables (`accounts`, `account_members`, `agents`) and one `requireAgent` guard that every future `/api/agents/:agentId/*` route reuses. The frontend loses `DataProvider` and the fixture-era screens, and gains an agent picker plus seven section shells that render honest empty states until later stages fill them.

**Tech Stack:** Fastify 5, Drizzle ORM 0.45 + drizzle-kit, PostgreSQL, Zod 4, Vitest 4 · React 18, Vite 5, react-router-dom 6.

**Spec:** [`docs/superpowers/specs/2026-09-02-tenancy-and-shell-design.md`](../specs/2026-09-02-tenancy-and-shell-design.md)

## Global Constraints

- **Language.** Code, comments, commit messages and docs in English. Every string a user reads stays Russian — this cabinet's users are Russian-speaking sellers.
- **Commands run from the repository root.** `npm --prefix server …`, `npm --prefix rakurs …`. Running them from elsewhere makes npm look for a package.json that is not there.
- **Server tests need the test database:** `docker compose -f deploy/compose.test.yml up -d`. It listens on port 55432 and is wiped every run.
- **No fixtures, no invented data.** A screen with no endpoint behind it says so. A number with no source is not rendered.
- **The frontend renders `message` from an error response verbatim,** so every server-side error message is user-facing Russian prose.
- **Role vocabulary:** `owner` and `member` only, spelled exactly that way in the database, the API and the code.
- **Timezone default:** `Asia/Almaty`.
- **Никогда** не удаляйте `.env` файлы и базу разработки: `deploy/compose.dev.yml` держит данные на именованном томе, и там живут учётные записи.

## File structure

| File | Responsibility |
|---|---|
| `server/src/db/schema.ts` | Table definitions. Gains accounts, members, agents; loses `settings` and `users.role`. |
| `server/src/lib/provision.ts` | Creating an account with its owner, and adding a member. Pure functions over a `Db`, so the scripts stay thin and the logic is testable. |
| `server/src/scripts/create-account.ts` | Stdin wrapper around `createAccountWithOwner`. |
| `server/src/scripts/add-member.ts` | Stdin wrapper around `addMember`. |
| `server/src/api/require-agent.ts` | The `requireAgent` guard: membership lookup, 404/403 decision, `req.agent`. |
| `server/src/api/agents.ts` | Agent list, create, read, patch. |
| `server/src/api/auth.ts` | Login, logout, and `/api/auth/me` now answering with accounts. |
| `server/src/lib/me.ts` | Builds the `Me` payload from a user row. Shared by login and `/auth/me`. |
| `packages/contract/index.ts` | `Role`, `Account`, `Agent`, `Me`. Everything prototype-era is deleted. |
| `rakurs/src/api/index.ts` | The four calls this stage needs. |
| `rakurs/src/store/agent.tsx` | The agent the URL points at, loaded once per `/a/:agentId` subtree. |
| `rakurs/src/screens/AgentsScreen.tsx` | Agent picker with the create dialog. |
| `rakurs/src/screens/sections/*.tsx` | Seven section shells. |
| `rakurs/src/components/layout/{Sidebar,Header,Layout}.tsx` | The shell chrome. |

## Tasks

Each task ends green: `npm --prefix server test`, `npm --prefix server run typecheck`, `npm --prefix rakurs run typecheck` and `npm --prefix rakurs run build` all pass before the commit.

| # | Task | File |
|---|---|---|
| 1 | Schema, migration, and dropping the settings row | [task-1-schema.md](2026-09-02-tenancy-task-1-schema.md) |
| 2 | Provisioning accounts, owners and members | [task-2-provisioning.md](2026-09-02-tenancy-task-2-provisioning.md) |
| 3 | The agent guard | [task-3-agent-guard.md](2026-09-02-tenancy-task-3-agent-guard.md) |
| 4 | Agent API and the contract | [task-4-agent-api.md](2026-09-02-tenancy-task-4-agent-api.md) |
| 5 | Frontend teardown | [task-5-frontend-teardown.md](2026-09-02-tenancy-task-5-frontend-teardown.md) |
| 6 | Agent picker and routing | [task-6-agent-picker.md](2026-09-02-tenancy-task-6-agent-picker.md) |
| 7 | The shell: sidebar, header, sections | [task-7-shell.md](2026-09-02-tenancy-task-7-shell.md) |
| 8 | Agent settings, creation, and the README | [task-8-agent-settings.md](2026-09-02-tenancy-task-8-agent-settings.md) |

Tasks 1–4 are the server and can be reviewed without a browser. Task 5 is a deletion pass that must land before 6–8: the old screens and the old contract types die together.

## Definition of done

- A fresh database plus `npm --prefix server run create-account` gives a working login.
- The picker lists that account's agents; an owner can create another one; a member cannot.
- Every section route renders under the sidebar and says which stage will fill it.
- Requesting another account's agent returns 404, and a member on an owner-only route gets 403, both covered by tests.
- No file in `rakurs/src` imports a fixture, and `mock-server/` is gone.
