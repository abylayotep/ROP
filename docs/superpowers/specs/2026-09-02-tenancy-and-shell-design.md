# Tenancy and shell

**Date:** 2026-09-02
**Status:** Approved. Ready for implementation planning.
**Sub-project:** 1 of 7 in the pleep-model rebuild.

## Goal

Turn Rakurs from a single-company cabinet into a multi-tenant workspace, and replace the
seven prototype screens with the navigation the new product needs. Nothing in this pass
talks to WhatsApp, Meta or a model: it builds the container every later sub-project fills.

Reference for what the container has to hold: [pleep research](2026-09-02-pleep-research.md).

## Starting point

| | |
|---|---|
| Backend | Fastify + Drizzle. Three tables: `users`, `sessions`, `settings` (one pinned row). |
| Auth | Session cookie, argon2, `requireSession` guard, `create-user` script. Works. |
| Frontend | React + Vite. `LoginScreen` and `AuthProvider` real; seven screens read `DataProvider`, which calls endpoints that mostly do not exist. |
| Contract | `packages/contract/index.ts`, ~330 lines of prototype-era types. |

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Tenancy shape | Account → many agents, like pleep | One company can sell several products with different scripts, knowledge and funnels. The extra level is cheap now and expensive to retrofit. |
| Isolation | `agent_id` column plus a `requireAgent` guard | Row-level security means session variables on a pooled connection and a second place where access rules live. A guard with tests is enough for this scale. |
| Sign-up | None | Accounts are created with a script during the closed beta. A public registration endpoint is an attack surface with no user behind it yet. |
| Roles | `owner`, `member` | Owner does everything. Member reads dialogs and orders and answers as an operator. A third middle role has no distinct job yet. |
| Old screens | Deleted, not hidden | Creatives, Sellers, Broadcast, Overview and Agent were built for a different product and read fixtures. Keeping them means keeping `DataProvider` and 330 lines of dead contract. |
| Settings row | Dropped | It held Meta ids for a single tenant. Those belong to per-agent tables in sub-projects 2 and 6. |

## Data model

New tables, migration `0001`:

```
accounts          id uuid pk, name text, created_at
account_members   account_id fk→accounts cascade, user_id fk→users cascade,
                  role text ('owner'|'member'), created_at, pk(account_id, user_id)
agents            id uuid pk, account_id fk→accounts cascade, name text,
                  description text not null default '', timezone text not null,
                  created_at, index(account_id)
```

Dropped in the same migration: `settings`, and the `role` column on `users` (role is a
property of a membership, not of a person).

Every domain table from sub-project 2 onward carries `agent_id` and reaches the account
through it. Nothing outside this spec joins to `accounts` directly.

## Access control

`requireSession` is unchanged. A new `requireAgent(db, { role })` guard runs after it on
every `/api/agents/:agentId/*` route:

1. Read `:agentId`. Not a uuid → 404.
2. One query joins `agents` to `account_members` on the session user. No row → **404
   "Агент не найден"**. Not 403: a 403 confirms the agent exists to someone who cannot see it.
3. `role: 'owner'` and the membership is `member` → 403 "Недостаточно прав".
4. On success attach `req.agent` and `req.membershipRole`.

The guard is built once in `buildServer` and shared, the way `requireSession` already is.

## API

| Method | Path | Role | Returns |
|---|---|---|---|
| GET | `/api/auth/me` | any session | user (name, initials, email) and their accounts with role |
| GET | `/api/accounts/:accountId/agents` | member | agents of that account |
| POST | `/api/accounts/:accountId/agents` | owner | creates an agent from name, description, timezone |
| GET | `/api/agents/:agentId` | member | one agent |
| PATCH | `/api/agents/:agentId` | owner | renames, re-describes, changes timezone |

`POST /api/auth/login` returns the same payload as `GET /api/auth/me`, so the client stores one
type either way — the rule the login route already follows.

`/api/profile` and `/api/settings` are removed with the row they read. Deleting an agent is
deliberately absent: an agent owns conversations and money data, so removal needs its own
design once that data exists.

## Provisioning

Two scripts, both reading stdin line by line so `docker compose run` and tests can pipe them,
the way `create-user` already does:

- `create-account` — company name, email, name, initials, password. Creates the account, the
  user, and an `owner` membership. Replaces `create-user`.
- `add-member` — account name, email, name, initials, password, role. For adding a second
  person to an existing account.

Passwords never come from argv: arguments land in shell history and in `ps`.

## Frontend

Routes:

```
(no route)                      — the login screen replaces the app while anonymous
/                               — agent picker: cards for the account's agents,
                                  "Создать агента" for owners.
                                  One account with one agent redirects straight in.
/a/:agentId/orders              — Заказы
/a/:agentId/dialogs             — Диалоги
/a/:agentId/knowledge           — База знаний
/a/:agentId/agent               — Агент
/a/:agentId/integrations        — Интеграции
/a/:agentId/stats               — Статистика
/a/:agentId/settings            — Настройки
```

`Sidebar` keeps its shape and tokens, loses the prototype counters, and gains the agent name
with a switcher at the top and the user with "Выйти" at the bottom. `Header` keeps the theme
toggle and the section title; the period selector and "Обновлено N минут назад" go with the
data they described.

Every section renders an honest empty state — "Раздел появится на этапе N" — through the
existing `states.tsx`. This is the same convention the README already documents, so a reader
can tell an unfinished section from a broken one.

Deleted: `mock-server/`, `store/data.tsx`, `lib/selectors.ts`, `lib/navigation.ts`, the seven
old screens and the `components/{creatives,dialogs,sellers,settings}` directories.
Kept: `LoginScreen`, `store/auth.tsx`, `store/app-state.tsx` (trimmed to theme), `api/client.ts`,
`hooks/useApi.ts`, `components/ui/*`, `styles/*`.

`packages/contract` is reduced to what this pass serves: `Role`, `Account`, `Agent`, `Me`.
Types return per sub-project, next to the endpoints that emit them.

## Testing

Server, with the existing test database:

- `requireAgent`: another account's agent → 404; a member on an owner-only route → 403; an
  own agent → 200; a malformed id → 404.
- Agent create and patch: validation, and that a created agent belongs to the caller's account.
- The provisioning library: duplicate email, a short password, an unknown company, an
  ambiguous company name, and that a failed user insert leaves no orphan account. The scripts
  themselves are thin stdin wrappers and are exercised by hand once.

Frontend: `typecheck` and `build`. The screens are empty states, so there is nothing to assert
beyond the routes compiling and an anonymous visitor getting the login screen.

## Out of scope

Email invitations, changing a role from the UI, deleting agents or accounts, billing and
quotas, mobile layout. Each is its own pass once there is something to protect.
