# Linked-Device Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect the WhatsApp number already running on an owner's phone by scanning a QR code in the cabinet, through Baileys, and carry text and media both ways into the existing Диалоги, funnel and agent.

**Architecture:** A third `connection_kind` beside `manual` and `coexistence`. One Baileys socket per connected number lives in the Fastify process, its session stored encrypted in Postgres. Incoming events are normalized into the shape the Cloud API pipeline already writes, so contacts, conversations, messages and agent turns are shared code. Sending goes through a `MessageTransport` interface picked by the number's kind; the 24-hour window becomes a property of the transport rather than an unconditional check.

**Tech Stack:** Fastify 5, Drizzle ORM 0.45 + drizzle-kit, PostgreSQL, Zod 4, Vitest 4 · `@whiskeysockets/baileys` 6.7.24 · React 18, Vite.

**Spec:** [`docs/superpowers/specs/2026-09-11-baileys-linked-transport-design.md`](../specs/2026-09-11-baileys-linked-transport-design.md)

## Global Constraints

- **Language.** Code, comments, commit messages and docs in English. Every string a user reads stays Russian; the frontend renders a server error's `message` verbatim.
- **Commands run from the repository root:** `npm --prefix server …`, `npm --prefix rakurs …`.
- **Server tests need the test database** on port 55432 (`docker compose -f deploy/compose.test.yml up -d`). A refused localhost connection reported as `connect EPERM` is the sandbox, not a broken test.
- **`npm install` in a fresh worktree needs `--cache "$TMPDIR/npm-cache"`** — `~/.npm` holds root-owned files.
- **No test may reach the network and no test may open a real socket.** `LinkedClient` is an interface; tests inject `fakeLinked()` from `server/test/helpers/fake-linked.ts`.
- **Baileys is pinned to exactly `6.7.24`** — no caret, no `7.0.0-rc*`. It is imported in exactly one file, `server/src/lib/whatsapp/linked/socket.ts`.
- **`connection_kind` values are exactly `manual`, `coexistence` and `linked`.** `linked_state` values are exactly `pairing`, `open`, `logged_out`.
- **Secrets never reach a response body.** Session material is encrypted with `CREDENTIALS_KEY` through `encryptSecret`/`decryptSecret` and is never selected into an API type.
- **Every task ends green:** `npm --prefix server test` and `npm --prefix server run typecheck`; any task touching `rakurs/` or `packages/contract` also runs `npm --prefix rakurs run typecheck` and `npm --prefix rakurs run build`.
- **Markdown files stay under 500 lines.**
- **Four test files fail intermittently under load** — `capi-queue`, `session`, `whatsapp-inbound`, `knowledge-import-text`. A failure that passes on rerun is almost always one of these, not the task's work.

## File structure

| File | Responsibility |
|---|---|
| `server/src/db/schema.ts` + `server/drizzle/00NN_*.sql` | `linked` kind, nullable Cloud API columns, `linked_jid`, `linked_state`, `linked_session_keys`. |
| `packages/contract/index.ts` | `WhatsappNumber` gains `connectionKind` widening and `linkedState`; `LinkedPairingEvent`. |
| `server/src/lib/whatsapp/linked/auth-state.ts` | Baileys auth state backed by `linked_session_keys`. |
| `server/src/lib/whatsapp/linked/client.ts` | The `LinkedClient` interface and the registry of live sessions. |
| `server/src/lib/whatsapp/linked/socket.ts` | The only file that imports Baileys. |
| `server/src/lib/whatsapp/linked/normalize.ts` | One Baileys message → the shape the store writes. |
| `server/src/lib/whatsapp/linked/queue.ts` | Per-number send queue with a minimum gap. |
| `server/src/lib/whatsapp/linked/history.ts` | `messaging-history.set` → rows, no agent turns. |
| `server/src/lib/whatsapp/store.ts` | Contact, conversation, message and turn writers, shared by both transports. |
| `server/src/lib/whatsapp/transport.ts` | `MessageTransport`, `transportFor`. |
| `server/src/api/whatsapp-linked.ts` | Pairing, the QR event stream, unlinking. |
| `server/src/index.ts` | Restores open sessions on boot. |
| `rakurs/src/screens/IntegrationsScreen.tsx` | The «Подключить телефон по QR» card. |
| `docs/whatsapp-linked.md` | How to connect a phone, and what it costs. |

## Tasks

| # | Task | File |
|---|---|---|
| 1 | Merge `claude/meta-capi` into `main` | [task-1-merge.md](2026-09-11-baileys-task-1-merge.md) |
| 2 | Dependency, schema, migration, contract | [task-2-schema.md](2026-09-11-baileys-task-2-schema.md) |
| 3 | Auth state over Postgres | [task-3-auth-state.md](2026-09-11-baileys-task-3-auth-state.md) |
| 4 | `LinkedClient`: interface, fake, socket | [task-4-client.md](2026-09-11-baileys-task-4-client.md) |
| 5 | Extract the shared writers | [task-5-store.md](2026-09-11-baileys-task-5-store.md) |
| 6 | Normalize and store what the socket receives | [task-6-inbound.md](2026-09-11-baileys-task-6-inbound.md) |
| 7 | The transport interface and the window rule | [task-7-transport.md](2026-09-11-baileys-task-7-transport.md) |
| 8 | Send queue, boot restore, reconnect | [task-8-lifecycle.md](2026-09-11-baileys-task-8-lifecycle.md) |
| 9 | Pairing routes and the QR stream | [task-9-pairing.md](2026-09-11-baileys-task-9-pairing.md) |
| 10 | The integrations screen | [task-10-screen.md](2026-09-11-baileys-task-10-screen.md) |
| 11 | History import, outgoing media, docs | [task-11-history-docs.md](2026-09-11-baileys-task-11-history-docs.md) |

## A known deviation from the plan format

Tasks 6, 7, 9, 10 and 11 list their tests by name and expectation but leave several bodies
as `{ … }` rather than spelling out every assertion. The plan format asks for complete test
code. These are written to be executed by the author of the spec, in this session, with the
codebase in context; an executor arriving cold should write the body the name and the
surrounding text describe, and should treat a test they cannot write from that description
as a gap worth asking about rather than guessing.

## Order and independence

Tasks 1–4 are strictly sequential. Task 5 is a pure refactor and can run beside Task 4. Tasks 6 and 7 both depend on 5; 6 also depends on 4. Task 8 depends on 4 and 7, Task 9 on 8, Task 10 on 9, Task 11 on 6 and 9.

Nothing in this plan is reachable from the cabinet until Task 9 lands; up to that point the work is exercised by tests only.
