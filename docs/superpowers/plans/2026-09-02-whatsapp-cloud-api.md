# WhatsApp Cloud API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect a WhatsApp number through Meta's official Cloud API, store every message, let an operator answer from the cabinet, and capture the click-to-WhatsApp attribution stage 6 needs.

**Architecture:** One application-level webhook receives everything and routes by `phone_number_id`. It verifies Meta's signature over the raw bytes, stores the payload, answers `200`, and only then parses — so a bug in our parser cannot lose a message. Outbound sends and media downloads go through one small Graph client behind an interface, which the tests replace with a fake, so no test reaches the network.

**Tech Stack:** Fastify 5, Drizzle ORM 0.45 + drizzle-kit, PostgreSQL, Zod 4, Vitest 4, Node's built-in crypto and fetch · React 18, Vite 5, react-router-dom 6.

**Spec:** [`docs/superpowers/specs/2026-09-02-whatsapp-cloud-api-design.md`](../specs/2026-09-02-whatsapp-cloud-api-design.md)

## Global Constraints

- **Language.** Code, comments, commit messages and docs in English. Every string a user reads stays Russian — the frontend renders a server error's `message` verbatim.
- **Commands run from the repository root:** `npm --prefix server …`, `npm --prefix rakurs …`.
- **Server tests need the test database** on port 55432 (`docker compose -f deploy/compose.test.yml up -d`). A refused localhost connection reported as `connect EPERM` is the sandbox, not a broken test.
- **No test may reach the network.** The Graph client is an interface; tests inject a fake.
- **No fixtures and no invented data.** A screen with no endpoint behind it says so.
- **Role vocabulary:** `owner` and `member`, spelled exactly that way. Connecting or editing a number is owner-only; reading and answering conversations is open to any member.
- **An agent or account the caller does not belong to answers 404, never 403.** 403 is only the answer after membership is proven. The guards are `requireAgent` and `requireAccount`.
- **Graph API version is `v21.0`,** written once as a constant.
- **Phone numbers are stored as digits only,** the shape WhatsApp uses in `wa_id`.

## File structure

| File | Responsibility |
|---|---|
| `server/src/env.ts` | Five new variables, validated at boot. |
| `server/src/lib/secret-box.ts` | Encrypting and decrypting an access token at rest. |
| `server/src/db/schema.ts` | The five new tables. |
| `server/src/lib/whatsapp/graph.ts` | The Graph client interface and its fetch implementation. |
| `server/src/lib/whatsapp/signature.ts` | Verifying `X-Hub-Signature-256` over raw bytes. |
| `server/src/lib/whatsapp/inbound.ts` | Turning one stored payload into contacts, conversations and messages. |
| `server/src/lib/whatsapp/media.ts` | Downloading an inbound file and writing it to disk. |
| `server/src/api/whatsapp-webhook.ts` | The two unauthenticated webhook routes, in their own Fastify scope. |
| `server/src/api/whatsapp-numbers.ts` | Connecting, listing and disabling a number. |
| `server/src/api/conversations.ts` | Listing conversations, reading a thread, sending, streaming media. |
| `rakurs/src/screens/sections/IntegrationsScreen.tsx` | The WhatsApp connection form and its status. |
| `rakurs/src/screens/sections/DialogsScreen.tsx` | Conversation list, thread and composer. |
| `packages/contract/index.ts` | The types both sides read. |

## Tasks

Each task ends green: `npm --prefix server test`, `npm --prefix server run typecheck`, and for any task touching `rakurs/`, `npm --prefix rakurs run typecheck` and `npm --prefix rakurs run build`.

| # | Task | File |
|---|---|---|
| 1 | Configuration and the secret box | [task-1-config.md](2026-09-02-whatsapp-task-1-config.md) |
| 2 | Schema and migration | [task-2-schema.md](2026-09-02-whatsapp-task-2-schema.md) |
| 3 | The Graph client | [task-3-graph-client.md](2026-09-02-whatsapp-task-3-graph-client.md) |
| 4 | The webhook: handshake, signature, storage | [task-4-webhook.md](2026-09-02-whatsapp-task-4-webhook.md) |
| 5 | Turning a payload into messages | [task-5-inbound.md](2026-09-02-whatsapp-task-5-inbound.md), [its test file](2026-09-02-whatsapp-task-5-inbound-test.md) |
| 6 | Click-to-WhatsApp attribution | [task-6-attribution.md](2026-09-02-whatsapp-task-6-attribution.md) |
| 7 | Media | [task-7-media.md](2026-09-02-whatsapp-task-7-media.md) |
| 8 | Connecting a number | [task-8-numbers-api.md](2026-09-02-whatsapp-task-8-numbers-api.md), [its test file](2026-09-02-whatsapp-task-8-numbers-test.md) |
| 9 | Conversations over the API | [task-9-conversations-api.md](2026-09-02-whatsapp-task-9-conversations-api.md), [its test file](2026-09-02-whatsapp-task-9-conversations-test.md) |
| 10 | The integrations screen | [task-10-integrations-screen.md](2026-09-02-whatsapp-task-10-integrations-screen.md) |
| 11 | The dialogs screen | [task-11-dialogs-screen.md](2026-09-02-whatsapp-task-11-dialogs-screen.md) |
| 12 | Documentation and deployment | [task-12-docs-deploy.md](2026-09-02-whatsapp-task-12-docs-deploy.md) |

Tasks 1 to 9 are the server and need no browser. Task 3 produces the interface tasks 7, 8 and 9 depend on, so it lands before any of them.

Three tasks keep their test file in a sibling document so that neither crosses the five-hundred-line limit this repository keeps. An implementer working one of those tasks is given both paths.

## Definition of done

- A signed payload posted at the webhook creates a contact, a conversation and a message, and posting it twice creates one message.
- A first message carrying `referral` fills the conversation's attribution; a later one does not overwrite it.
- An operator sends a reply inside the window and is refused outside it, in Russian.
- An inbound photo is on disk and renders in the thread through an authenticated route.
- Connecting a number validates the token with Meta and subscribes the application to the WABA.
- No test reaches the network, and the whole suite runs without a tunnel or a live number.
