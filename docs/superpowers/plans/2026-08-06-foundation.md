# Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deployable Rakurs with a real server, database and authentication, where every screen loads behind a login and shows honest empty states instead of fixtures.

**Architecture:** An npm workspace holds three packages — the existing frontend, a new Fastify server, and a shared contract package that both import so the API contract cannot drift. The server owns sessions, settings and the profile; everything else arrives in later plans.

**Tech Stack:** Node + TypeScript, Fastify, PostgreSQL, Drizzle ORM, Vitest, argon2, Zod, Docker Compose.

## Global Constraints

- Repository artifacts are English — identifiers, comments, commits, docs. Product strings the user reads stay Russian.
- Markdown files stay under 200 lines. Split by topic and leave an index.
- No secret may carry a `VITE_` prefix. That prefix compiles the value into the browser bundle. The frontend's only config is `VITE_API_URL=/api`.
- Never send `0` where the truth is "not known" — send `null` and let the screen say so.
- Sessions are httpOnly, `Secure`, `SameSite=Lax`. Passwords are argon2id.
- Every endpoint requires a session except `POST /api/auth/login`.
- Every task ends with tests passing and a commit.

## Plan sequence

This is plan 1 of 5. Each produces working software; later plans are written when reached, against the state the previous one left.

| # | Plan | Delivers |
|---|---|---|
| 1 | Foundation (this) | Deployable server, database, login, settings |
| 2 | Meta | Real spend and ads on the Creatives screen, tracking codes |
| 3 | WhatsApp | Baileys bridge, QR linking, live conversations, attribution |
| 4 | Analysis | Model-driven dialog analysis, Sellers screen metrics |
| 5 | Money | Payment import, Conversions API, reconciliation, Overview |

## File structure

```
package.json                    workspace root (new)
packages/contract/
  package.json                  @rakurs/contract (new)
  index.ts                      moved from rakurs/src/types/index.ts
rakurs/src/types/index.ts       becomes a re-export of @rakurs/contract
rakurs/src/screens/LoginScreen.tsx   (new)
server/
  package.json  tsconfig.json  drizzle.config.ts  vitest.config.ts
  src/
    env.ts                      environment parsing and validation
    db/client.ts                Postgres connection
    db/schema.ts                users, sessions, settings
    lib/password.ts             argon2id hash and verify
    lib/session.ts              create, find, revoke
    lib/errors.ts               ApiError and the Fastify error handler
    api/server.ts               Fastify instance, plugins, route registration
    api/auth.ts                 login, logout, me
    api/profile.ts              GET /profile
    api/settings.ts             GET and PATCH /settings
    api/require-session.ts      preHandler guard
    index.ts                    entrypoint
    scripts/create-user.ts      CLI for the first user
  test/                         one file per unit, plus integration/
deploy/
  compose.yml  compose.test.yml  nginx.conf  env.example
```

Each server file has one responsibility and stays small enough to hold in context. Routes never touch the database directly — they call `lib/`, which owns the queries. That boundary is what makes the route files testable without a database and the `lib/` files testable without HTTP.

## Tasks

One file per task — that is also the unit of execution and review.

| # | Task | Depends on |
|---|---|---|
| 1 | [Workspace and shared contract package](2026-08-06-foundation-task-1-workspace.md) | — |
| 2 | [Server scaffold, env validation, health endpoint](2026-08-06-foundation-task-2-scaffold.md) | — |
| 3 | [Database schema, migrations, test Postgres](2026-08-06-foundation-task-3-database.md) | 2 |
| 4 | [Password hashing](2026-08-06-foundation-task-4-password.md) | 2 |
| 5 | [Sessions](2026-08-06-foundation-task-5-sessions.md) | 3 |
| 6a | [Server plumbing and the session guard](2026-08-06-foundation-task-6a-session-guard.md) | 5 |
| 6b | [Login, logout and /me](2026-08-06-foundation-task-6b-auth-routes.md) | 4, 6a |
| 7a | [The settings store](2026-08-06-foundation-task-7a-settings-store.md) | 1, 3 |
| 7b | [Profile and settings routes](2026-08-06-foundation-task-7b-profile-routes.md) | 6b, 7a |
| 8a | [Auth calls and the frontend auth store](2026-08-06-foundation-task-8a-auth-store.md) | 6b |
| 8b | [Login screen and the auth gate](2026-08-06-foundation-task-8b-login-screen.md) | 8a |
| 9a | [The first user](2026-08-06-foundation-task-9a-first-user.md) | 7b, 8b |
| 9b | [The deployment stack](2026-08-06-foundation-task-9b-deploy.md) | 9a |

Tasks 1 and 2 are independent of each other; everything after follows the dependency column.

## Carried into plan 2

`purgeExpiredSessions` (task 5) is written and tested but nothing calls it — there is no worker
process until plan 2. Schedule it there. Expired sessions are already rejected by
`findValidSession`, so this is table hygiene, not a security gap.

## Done when

`docker compose up` on the VPS serves the cabinet over the domain; an unauthenticated visitor
lands on the login screen; a user created by the CLI can sign in; the profile in the header and
the settings screen read from Postgres; `npm run typecheck` passes in both `rakurs/` and
`server/`; `npm test` passes in `server/` including integration tests against a real database.

Screens with no data yet render their existing empty and error states. That is the correct
outcome for this plan, not an unfinished one.
