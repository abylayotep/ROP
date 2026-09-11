# Linked-device transport: connecting a phone's WhatsApp without Meta

**Date:** 2026-09-11
**Status:** Approved. Ready for implementation planning.
**Stage:** 8 of the pleep-model rebuild. Builds on
[WhatsApp Cloud API](2026-09-02-whatsapp-cloud-api-design.md),
[WhatsApp coexistence](2026-09-04-whatsapp-coexistence-design.md),
[AI agent](2026-09-03-ai-agent-design.md).

## Goal

Let an owner connect the WhatsApp number already running on their phone by scanning a QR
code in the cabinet, with no Meta application, no App Review and no new SIM. Incoming and
outgoing messages — text and media, in both directions — appear in Диалоги, and the phone
keeps working as it always did.

This is the unofficial path: the cabinet registers itself as a **linked device**, the same
slot WhatsApp Web occupies, through the Baileys library.

## The decision this reverses, and what it costs

Two earlier decisions said not to do this. [The Cloud API
spec](2026-09-02-whatsapp-cloud-api-design.md) chose pasted credentials over anything
unofficial; [the coexistence spec](2026-09-04-whatsapp-coexistence-design.md) built Meta's
own way to connect a phone's number. Both stand. This stage adds a third transport beside
them because the official one cannot run until the product is deployed, the Meta application
becomes a Tech Provider and App Review passes — a wait measured in weeks, decided by Meta.

The owner accepted these costs explicitly, for their own production number:

- **It violates WhatsApp's terms.** The number can be banned, and a banned number is not
  appealable in practice. For Sealhouse that is the sales channel itself.
- **No `ctwa_clid`.** Click-to-WhatsApp attribution arrives only in the Cloud API webhook's
  `referral` block. A linked device never sees it, so Meta CAPI reports nothing for
  conversations that arrive this way. The CAPI stage keeps working for the Cloud API kinds
  and is simply blind to `linked` ones.
- **It breaks on its own schedule.** WhatsApp changes the protocol, the library follows.
  Upgrading Baileys becomes routine maintenance, not an occasional chore.

Nothing here removes the other two transports. A cabinet that grows out of the unofficial
path connects the number through Meta instead and keeps its conversations.

## Starting point

- `whatsapp_numbers` requires `phone_number_id` (unique), `waba_id` and an encrypted
  `access_token`. Every number today is a Cloud API number.
- Inbound runs as `processPendingEvents` over rows in `whatsapp_events`: a webhook stores the
  raw delivery, answers Meta `200`, and parsing happens afterwards. `applyChange`
  (`lib/whatsapp/inbound.ts`) resolves the number by `metadata.phone_number_id`, upserts the
  contact and the conversation, stores messages, then `runTurns` lets the agent answer.
- Outbound calls `graph.sendText(phoneNumberId, token, to, body)` from exactly two places:
  `api/conversations.ts` (an operator's line) and `lib/ai/turn.ts` (the agent's).
- `GraphClient` is an interface with a real implementation and a fake in tests. This is the
  pattern the new transport follows.
- The 24-hour window is enforced in the cabinet, before the send, by `windowOpen`.
- Media is downloaded when the message arrives and written under `MEDIA_DIR`, keyed by agent
  and WhatsApp message id.

## Facts about Baileys that shape the design

Verified against the published package on 2026-09-11.

| Fact | Consequence |
|---|---|
| Two lines are maintained in parallel: `6.7.24` and `7.0.0-rc14`, both published 2026-07-29. | Pin `6.7.24` exactly. A release candidate on a production number buys nothing; an unpinned range upgrades the protocol layer without anyone deciding to. |
| The socket is a long-lived WebSocket, not a request/response client. | The server owns a socket per connected number for as long as the process lives, and must restore them on boot. |
| Auth state is credentials plus a growing key store, written on almost every message. | Storing it as one blob rewrites everything on each write. It gets its own table, one row per key. |
| A QR code is emitted repeatedly on `connection.update` and expires in seconds. | Pairing is a stream, not a single image. The cabinet subscribes; it does not poll for one value. |
| `DisconnectReason.loggedOut` is terminal — the session cannot be resumed. | That one reason clears the stored session and asks for a new pairing. Every other reason reconnects. |
| Messages the owner sends from the phone arrive as `messages.upsert` with `key.fromMe`. | They are mirrored as outgoing operator lines, which is also what keeps the agent from answering a line a human already answered. |
| `messaging-history.set` delivers chats, contacts and messages after pairing, in chunks. | History import is an event handler, not a request we make. |
| There is no 24-hour window and no template concept. | `windowOpen` must not run for these numbers. |

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Library | `@whiskeysockets/baileys`, pinned `6.7.24` | The stable line, current as of the last release day. |
| Where the socket runs | In the Fastify process | One deploy, direct database access. A separate worker survives API restarts but costs a second service in operations; it can be extracted later behind the same interface. |
| Number identity | One table, a third `connection_kind` value | `conversations.whatsapp_number_id` already points at `whatsapp_numbers`. A second table would fork that chain and every query along it. |
| Session storage | Postgres, encrypted with `CREDENTIALS_KEY` | Containers are recreated; a file volume is one more thing to lose. The key already protects access tokens, and losing it already means re-entering credentials. |
| Transport selection | `MessageTransport` interface, chosen by `number.connectionKind` | The two send sites stay ignorant of transports, the way they are ignorant of HTTP today. |
| Inbound path | Normalize to the existing internal shape, reuse the existing writers | The conversation, contact, message and turn logic is transport-independent and already tested. |
| Agent on imported history | Never runs | Answering a question from four months ago is worse than not answering it. |
| Groups, calls, reactions, receipts, polls | Out of scope | Nothing in the product reads them today. |

## Data model

One migration, generated after the `claude/meta-capi` merge so it numbers after `0016`.

`whatsapp_numbers` gains:

- a third value in `connection_kind`, the column the coexistence stage already added:
  `'manual'` and `'coexistence'` are the two Cloud API paths, `'linked'` is this one. A
  second column would leave two places to ask the same question.
- `linked_jid` — the number's own WhatsApp id, null for the Cloud API kinds. Routing key
  for inbound.
- `linked_state` — `'pairing' | 'open' | 'logged_out'`, null for the Cloud API kinds.

`phone_number_id`, `waba_id` and `access_token` become nullable, and the unique index on
`phone_number_id` becomes partial (`where phone_number_id is not null`). A `linked` number
has none of the three, and a null in a unique index is not a collision, but the partial index
says the intent out loud.

Two checks the migration adds, because a half-filled row of either kind is a bug that would
otherwise surface as a failed send hours later:

- `connection_kind in ('manual', 'coexistence')` requires `phone_number_id`, `waba_id` and
  `access_token`;
- `connection_kind = 'linked'` requires `linked_jid` and `linked_state`.

New table `linked_session_keys`:

| Column | Meaning |
|---|---|
| `whatsapp_number_id` | Owner of the session, cascade on delete |
| `category` | Baileys' key type (`creds`, `pre-key`, `session`, `sender-key`, …) |
| `key_id` | Identity inside the category; `creds` uses a single fixed id |
| `value` | The serialized entry, encrypted with `CREDENTIALS_KEY` |
| `updated_at` | Written on every upsert |

Primary key is `(whatsapp_number_id, category, key_id)`. The auth-state adapter reads and
writes through this table and nothing else touches it.

## Components

### `lib/whatsapp/linked/client.ts` — the socket, behind an interface

```
interface LinkedClient {
  connect(numberId: string): Promise<void>;   // restores or starts a session
  disconnect(numberId: string): Promise<void>;
  sendText(numberId: string, to: string, body: string): Promise<{ messageId: string }>;
  sendMedia(numberId: string, to: string, file: OutgoingFile): Promise<{ messageId: string }>;
  on(event: LinkedEvent, handler: Handler): void; // qr, open, logged_out, message, history
}
```

The real implementation wraps `makeWASocket`; the test implementation emits events on
command. Nothing outside this file imports Baileys — the same rule `GraphClient` follows for
`fetch`, and the reason the rest of the code is testable without a phone.

### `lib/whatsapp/linked/auth-state.ts` — Baileys auth state over Postgres

Implements the shape Baileys expects (`state.creds`, `state.keys.get`, `state.keys.set`,
`saveCreds`) against `linked_session_keys`, encrypting on write and decrypting on read. Keys
are fetched in one query per `get` call, not one per key.

### `lib/whatsapp/linked/inbound.ts` — normalization

Turns a Baileys message into the shape `applyChange` already consumes: sender, id, timestamp,
kind, body or caption, media descriptor. `key.fromMe` produces an outgoing operator line and
skips the turn. Everything else routes into the existing writers.

The shared writers — `upsertContact`, `upsertConversation`, `storeMessage`, `runTurns` — move
out of `lib/whatsapp/inbound.ts` into `lib/whatsapp/store.ts`. `inbound.ts` is 500 lines and
already does two jobs; this split is what lets the second transport reuse the first one's
logic instead of copying it.

### `lib/whatsapp/transport.ts` — one interface, two implementations

```
interface MessageTransport {
  sendText(to: string, body: string): Promise<{ messageId: string }>;
  sendMedia(to: string, file: OutgoingFile): Promise<{ messageId: string }>;
  requiresOpenWindow: boolean;
}
```

`transportFor(number)` returns the cloud wrapper for `manual` and `coexistence`, the
linked wrapper for `linked`.
`requiresOpenWindow` is what replaces the unconditional `windowOpen` check: true for the
Cloud API kinds, false for `linked`. The check stays in one place and starts asking the transport
instead of assuming.

### `lib/whatsapp/linked/queue.ts` — send throttle

One queue per number, one message at a time, with a minimum gap and a small random jitter.
Bursts are the behaviour that gets a number banned fastest, and the agent can produce one.

### `api/whatsapp-linked.ts` — pairing and lifecycle

| Route | Does |
|---|---|
| `POST /api/agents/:agentId/whatsapp/linked` | Creates the row in `pairing`, starts a session. Owner only. |
| `GET /api/agents/:agentId/whatsapp/linked/:numberId/qr` | Server-sent events: each new QR string, then `open` or `failed`. Owner only. |
| `DELETE /api/agents/:agentId/whatsapp/linked/:numberId` | Logs the device out, drops the session keys, keeps conversations. Owner only. |

Media sending reuses the existing message route with a file part; `GET …/messages/:id/media`
already serves what was received.

### Boot

On start, every `linked` number with `linked_state = 'open'` and `enabled = true` is
connected, sequentially, with failures logged and not fatal: a server that refuses to start
because one phone is unreachable takes every other client down with it.

## Flows

**Pairing.** Owner opens Интеграции, presses «Подключить телефон по QR». The route creates
the row and starts a session; the screen opens the event stream and draws each QR as it
arrives. The owner scans it in WhatsApp → Связанные устройства. On `open`, the server fills
`linked_jid` and `display_phone` from the socket, sets `linked_state = 'open'`, and the
stream sends its last event. The screen replaces the QR with the connected number.

**Incoming message.** Baileys emits `messages.upsert` → normalized → contact and conversation
upserted → message stored, media downloaded through the socket and written under `MEDIA_DIR`
→ `runTurns` if the agent is on and the line is not `fromMe`.

**Outgoing from the cabinet.** The route loads the number, picks the transport, skips the
window check because `requiresOpenWindow` is false, enqueues the send, stores the row with
the id the socket returns.

**Outgoing from the phone.** Arrives as `fromMe` → stored as an operator line → no turn. The
cabinet shows what the owner typed on their phone, in the same thread.

**Disconnect.** Any reason but `loggedOut` reconnects with a growing pause. `loggedOut` sets
`linked_state = 'logged_out'`, deletes the session keys, and the integrations screen shows a
red line with a «Подключить заново» button. Sends refuse with 409 and a sentence that says
which of the two happened.

## History import

`messaging-history.set` arrives in chunks after pairing. Each chunk is written through the
same writers, with two differences: no turn is ever run, and media is not downloaded during
the import — an imported message keeps its media descriptor and fetches the file the first
time someone opens the conversation.

Contacts from the phone fill `contacts.name` where the cabinet has no name, and never
overwrite one that is already there: a name the owner corrected in the cabinet outranks the
phone's address book.

Imported conversations land in the funnel's first stage and do not move on their own. What to
do with a six-month-old conversation is a question for the analysis stage, not this one.

## Error handling

| Situation | Answer |
|---|---|
| Send to a number whose socket is down | 409, «Телефон не на связи. Откройте WhatsApp на телефоне или подключите заново.» |
| Send to a `logged_out` number | 409, «Телефон отвязал кабинет. Нужно подключить заново по QR.» |
| Pairing never scanned | The stream closes after five minutes with `failed`, the row is deleted. Nothing half-created is left in the list. |
| Media download fails | The message is stored without its file, the reason is logged. Exactly what the Cloud API path does today. |
| Baileys throws inside an event handler | Caught per message: one bad message must not kill the socket and with it every other conversation on that number. |

## Testing

Every test drives the fake `LinkedClient`; none needs WhatsApp.

- Normalization: text, image with caption, voice, document; timestamps; unsupported kinds.
- `fromMe` is stored as an outgoing operator line and runs no turn.
- Transport selection: a `manual` number sends through the graph client, a `linked` number
  through the socket.
- The window check is enforced for `manual` and skipped for `linked`.
- Reconnect: a non-terminal disconnect reconnects; `loggedOut` clears the session and flips
  the state.
- The queue serializes sends and keeps the gap.
- Auth state round-trips through Postgres and is unreadable without the key.
- History import writes messages, runs no turns, and does not overwrite an existing contact
  name.
- The migration's checks reject a half-filled row of each kind.

## Out of scope

Groups, calls, reactions, read receipts, polls, statuses, and multi-device fan-out. The
analysis of imported history — knowledge-base notes, rules and a sales script — is stage C
and gets its own spec, as does vision on incoming photos and transcription of voice
messages, which both need `ChatMessage.content` to carry parts instead of a string.

## Sequencing

1. Merge `claude/meta-capi` into `main`. Eight conflicts, all small except the migration
   journal: both branches added an `0011`, and `main` is at `0016`. The coexistence migration
   is regenerated on top rather than renumbered by hand.
2. Schema, migration, session table.
3. Auth state over Postgres.
4. The client behind its interface, with the fake.
5. Shared writers extracted; normalization; inbound wired.
6. Transport interface; both send sites converted; the window check moved behind it.
7. Pairing routes, the event stream, the integrations screen.
8. Boot restore, reconnect, queue.
9. History import.
10. Docs: how to connect, what the risks are, what to do when the phone logs the cabinet out.
