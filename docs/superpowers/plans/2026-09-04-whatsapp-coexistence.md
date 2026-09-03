# WhatsApp Coexistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect the WhatsApp Business number an owner already uses on their phone through Meta's Embedded Signup coexistence flow, import the phone's contacts and 180 days of chat history, and mirror messages the operator sends from the phone into the cabinet.

**Architecture:** The browser runs Meta's Embedded Signup with `featureType: whatsapp_business_app_onboarding` and hands the short-lived `code` plus the WABA id to one server route, which exchanges the code, checks the number, subscribes the application, stores the number as `connection_kind = 'coexistence'` and fires both one-shot `smb_app_data` sync requests. The existing webhook pipeline learns three new fields (`smb_message_echoes`, `smb_app_state_sync`, `history`) plus `account_update`, all keyed on the change's `field` and written through the same idempotent inserts stage 2 built. The manual three-field path stays untouched as the second card.

**Tech Stack:** Fastify 5, Drizzle ORM 0.45 + drizzle-kit, PostgreSQL, Zod 4, Vitest 4, Node fetch · React 18, Vite, Meta's `connect.facebook.net/en_US/sdk.js` · Docker Compose on the Tasbaqa VPS behind Caddy.

**Spec:** [`docs/superpowers/specs/2026-09-04-whatsapp-coexistence-design.md`](../specs/2026-09-04-whatsapp-coexistence-design.md)

## Global Constraints

- **Language.** Code, comments, commit messages and docs in English. Every string a user reads stays Russian; the frontend renders a server error's `message` verbatim.
- **Commands run from the repository root:** `npm --prefix server …`, `npm --prefix rakurs …`.
- **Server tests need the test database** on port 55432 (`docker compose -f deploy/compose.test.yml up -d`). A refused localhost connection reported as `connect EPERM` is the sandbox, not a broken test.
- **No test may reach the network.** The Graph client is an interface; tests inject `fakeGraph()` from `server/test/helpers/fake-graph.ts`.
- **Graph API version becomes `v26.0`,** written once as `GRAPH_VERSION` in `server/src/lib/whatsapp/graph.ts`. Three existing tests assert the old `v21.0` URLs and are updated in Task 2.
- **Secrets never reach the browser or a response body.** `META_APP_SECRET` is used only server-side; `withoutSecret` redacts a token from Meta's error text before it is shown.
- **The manual connection route and its test file `server/test/whatsapp-numbers.test.ts` must keep passing unchanged** except where a task says otherwise.
- **`connection_kind` values are exactly `manual` and `coexistence`; the new `messages.author` value is exactly `phone`.**
- **Markdown files stay under 500 lines.** `docs/whatsapp-setup.md` is at 94, `deploy/README.md` at 96.
- **Production changes on the shared VPS wait for the owner's explicit go-ahead** (Task 1 says where).

## File structure

| File | Responsibility |
|---|---|
| `deploy/Caddyfile.rop` | The Caddy site block for `rop.tasbaqa.ru`, copied into the host's `/etc/caddy/Caddyfile`. |
| `deploy/README.md` | Gains the Caddy variant and the two new variables. |
| `server/src/env.ts` | `META_APP_ID`, `META_ES_CONFIG_ID`. |
| `server/src/lib/whatsapp/graph.ts` | `v26.0`; `exchangeCode`, `listPhoneNumbers`, `requestSmbAppData`; `getPhoneNumber` reads `is_on_biz_app`. |
| `server/src/db/schema.ts` + `server/drizzle/0011_*.sql` | Seven new columns on `whatsapp_numbers`. |
| `packages/contract/index.ts` | `WhatsappNumber` gains five fields; `EmbeddedSignupSetup`, `CoexistenceConnection`. |
| `server/src/api/whatsapp-numbers.ts` | `toApi` extended; token replacement refused for coexistence rows. |
| `server/src/api/whatsapp-coexistence.ts` | The setup route and the connect route. |
| `server/src/lib/whatsapp/inbound.ts` | Routing by `field`; echoes; contacts; `account_update`. |
| `server/src/lib/whatsapp/history.ts` | Importing one `history` change. |
| `rakurs/src/lib/embedded-signup.ts` | Loading the Facebook SDK and running the coexistence login. |
| `rakurs/src/screens/IntegrationsScreen.tsx` | Two cards; the numbers list shows kind, import progress, offboarding. |
| `rakurs/src/screens/DialogsScreen.tsx` | «с телефона» label. |
| `docs/whatsapp-setup.md` | Section on connecting the phone's number. |

## Tasks

Each task ends green: `npm --prefix server test`, `npm --prefix server run typecheck`, and for any task touching `rakurs/` or `packages/contract`, `npm --prefix rakurs run typecheck` and `npm --prefix rakurs run build`.

| # | Task | File |
|---|---|---|
| 1 | Deploy to `rop.tasbaqa.ru` | [task-1-deploy.md](2026-09-04-coexistence-task-1-deploy.md) |
| 2 | Configuration and Graph v26.0 | [task-2-config.md](2026-09-04-coexistence-task-2-config.md) |
| 3 | Schema, migration, contract | [task-3-schema.md](2026-09-04-coexistence-task-3-schema.md) |
| 4 | Graph client: code exchange, numbers, sync requests | [task-4-graph.md](2026-09-04-coexistence-task-4-graph.md) |
| 5 | The coexistence connect route | [task-5-connect.md](2026-09-04-coexistence-task-5-connect.md) |
| 6 | Webhook: echoes and contacts | [task-6-echoes.md](2026-09-04-coexistence-task-6-echoes.md) |
| 7 | Webhook: history import | [task-7-history.md](2026-09-04-coexistence-task-7-history.md) |
| 8 | Webhook: account updates | [task-8-account.md](2026-09-04-coexistence-task-8-account.md) |
| 9 | The integrations screen | [task-9-screen.md](2026-09-04-coexistence-task-9-screen.md) |
| 10 | Dialogs label, docs, Meta setup checklist | [task-10-docs.md](2026-09-04-coexistence-task-10-docs.md) |

Task 1 is independent of the rest and can run first or in parallel. Tasks 2 → 3 → 4 → 5 are sequential. Tasks 6, 7, 8 depend on 3 and on each other only through `inbound.ts` (do them in order). Task 9 depends on 5. Task 10 depends on everything.
