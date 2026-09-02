# WhatsApp Cloud API

**Date:** 2026-09-02
**Status:** Approved. Ready for implementation planning.
**Stage:** 2 of 7 in the pleep-model rebuild. Builds on
[tenancy and shell](2026-09-02-tenancy-and-shell-design.md).

## Goal

Connect a WhatsApp number through Meta's official Cloud API, store every message that
arrives, let an operator answer from the cabinet, and capture the click-to-WhatsApp
attribution that stage 6 reports back to Meta.

The attribution is the part that cannot be recovered later: `ctwa_clid` appears once, on the
first message of a conversation that started from an ad, and never again. A stage that stores
messages but drops that field would have to be redone before stage 6 could work at all.

## Starting point

Stage 1 left an account owning agents, a `requireAgent` guard, and a cabinet whose Диалоги and
Интеграции sections say which stage will fill them.

Every table added here belongs to an agent, though not all of them say so in a column:
`messages` reaches its agent through its conversation, and `whatsapp_events` holds a payload
nobody has parsed yet, so at the moment it is written there is no agent to record. Every query
that serves a request still filters by the agent the guard proved.

The client for this build has a dedicated SIM, separate from the number their pleep trial
still uses. Development happens locally; the VPS comes later.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Transport | Official Cloud API, credentials pasted by hand | Embedded Signup needs Meta Tech Provider status and App Review. Pasting `waba_id`, `phone_number_id` and a system-user token needs neither, and reaches the same API. |
| Webhook address | One per application, not per number | Meta subscribes a webhook to an app, not to a phone. The payload's `metadata.phone_number_id` says which agent it belongs to. |
| Webhook order of work | Store the raw event, answer `200`, then parse | Meta retries only on a non-`200`, so parsing before answering loses a message on any bug in our own code. The stored payload can be parsed again. |
| Duplicate delivery | Ignore by WhatsApp's message id | Meta delivers the same message more than once by design. A unique index is the whole defence. |
| Token storage | AES-256-GCM, key from the environment | A database dump or a careless `psql` session would otherwise hand over the ability to send as the client. Retrofitting encryption means re-entering every token. |
| Media | Downloaded when the message arrives | Meta's media URL expires in minutes and the file itself is deleted after thirty days. Fetching on demand means showing a broken image to anyone who scrolls up. |
| Outbound in this stage | Operator only | The AI answers in stage 5. An operator typing in the cabinet is what proves the transport both ways. |
| Templates | Out of scope | A closed 24-hour window refuses the send with an explanation. Templates need Meta approval and a broadcast screen, which is its own stage. |

## Data model

Migration `0002`, every table keyed to an agent:

```
whatsapp_numbers   id, agent_id fk→agents cascade, phone_number_id text unique,
                   waba_id text, display_phone text, access_token text (encrypted),
                   enabled boolean not null default true, subscribed_at timestamptz,
                   created_at
contacts           id, agent_id fk→agents cascade, phone text, name text,
                   created_at, unique(agent_id, phone)
conversations      id, agent_id fk→agents cascade, contact_id fk→contacts cascade,
                   whatsapp_number_id fk→whatsapp_numbers cascade,
                   last_inbound_at timestamptz, last_message_at timestamptz,
                   ctwa_clid text, ad_source_id text, ad_source_type text,
                   ad_headline text, ad_body text, referral_seen_at timestamptz,
                   created_at, unique(whatsapp_number_id, contact_id)
messages           id, conversation_id fk→conversations cascade,
                   wa_message_id text unique, direction text, author text,
                   kind text, body text, media_path text, media_mime text,
                   status text, sent_at timestamptz, created_at
whatsapp_events    id, payload jsonb, received_at,
                   processed_at timestamptz, error text
```

`phone` holds digits only, the shape WhatsApp itself uses in `wa_id`. `direction` is `in` or
`out`; `author` is `client`, `operator` or `ai`, so stage 5 adds a value rather than a column.
`kind` is the WhatsApp message type: `text`, `image`, `audio`, `video`, `document`, `sticker`,
`location`, `contacts`, `unsupported`.

## The webhook

`GET /api/whatsapp/webhook` answers Meta's verification handshake: when `hub.mode` is
`subscribe` and `hub.verify_token` matches the configured string, it replies with
`hub.challenge` as plain text. Anything else is a `403` with no body.

`POST /api/whatsapp/webhook` is the only unauthenticated write in the product, so it is also
the only route that verifies who is calling by cryptography rather than by session:

1. Read the body as raw bytes. Fastify parses JSON by default, and a re-serialised body does
   not hash to the same value, so this route registers its own content-type parser.
2. Compute HMAC-SHA256 of those bytes with the application secret and compare it to
   `X-Hub-Signature-256` in constant time. A mismatch, or a missing header, is a `401`.
3. Insert the payload into `whatsapp_events`.
4. Answer `200`.
5. Parse: for each message, find the number by `metadata.phone_number_id`, upsert the contact,
   upsert the conversation, insert the message unless its `wa_message_id` is already stored,
   download media if the message carries any, and stamp `processed_at`. A failure writes
   `error` and leaves the row for a later re-run.

Status callbacks (`sent`, `delivered`, `read`, `failed`) update the matching message's
`status`. An event about a `phone_number_id` we do not know is stored, stamped as processed,
and otherwise ignored: another client's number on the same application is not an error.

## Attribution

An inbound message that began with a click on a Facebook or Instagram ad carries a `referral`
object: `source_id` (the ad), `source_type`, `headline`, `body`, and `ctwa_clid`. It appears on
the first message only.

Those fields are written to the conversation once, when `referral_seen_at` is null. A
conversation that started any other way keeps them null, and every screen says the source is
unknown rather than guessing. Guessing by arrival time would silently assign revenue to the
wrong ad, which is worse than an honest gap.

## Sending

`POST /api/agents/:agentId/conversations/:conversationId/messages` takes text, sends it through
`POST /{phone_number_id}/messages` with the number's decrypted token, stores the returned
message id, and returns the stored row.

WhatsApp allows free-form replies for 24 hours after the customer's last message. The route
computes that from `last_inbound_at` and refuses a late send with
`Окно ответа закрыто. Клиент должен написать первым, либо нужен шаблон.` Refusing locally
rather than letting Meta refuse keeps the error in the user's language and costs no API call.

## Media

An inbound media message carries an id, not a file. Processing calls `GET /{media_id}` for a
short-lived URL, downloads it with the token, and writes it under a configured directory as
`<agent_id>/<message_id>` plus the extension its mime type implies. The path goes in
`media_path`.

`GET /api/agents/:agentId/messages/:messageId/media` streams the file to a member of the
account. The token never reaches the browser, and neither does a Meta URL.

Downloads are capped at 25 MB, which is above WhatsApp's own limit for every type it accepts.
A failed download leaves the message stored with its text and no media, and records the reason
on the event.

## Screens

**Интеграции** replaces the WhatsApp placeholder with a form for `waba_id`, `phone_number_id`
and the access token, owner only. Saving validates the pair against Meta and then calls
`POST /{waba_id}/subscribed_apps`, which is what makes Meta deliver anything at all — a number
saved without it looks connected and stays silent. The screen shows the webhook address and the
verification string to paste into the Meta application, and the connected number with a switch
to disable it.

**Диалоги** replaces its placeholder with the list of conversations, most recently active
first, and the thread of the selected one: messages in order, images inline, the sender of each,
and a composer that is disabled with an explanation when the window is closed.

## Configuration

| Variable | Holds |
|---|---|
| `META_APP_SECRET` | Signs webhook deliveries; one per application |
| `META_WEBHOOK_VERIFY_TOKEN` | The string Meta echoes during the handshake |
| `CREDENTIALS_KEY` | 32 bytes, base64, encrypts access tokens at rest |
| `MEDIA_DIR` | Where downloaded files live |
| `PUBLIC_URL` | Shown on the integrations screen as the webhook address |

All five are validated at boot, like the two that exist today.

## Testing

The webhook is tested by signing a payload with the same secret and injecting it into the
route: no tunnel, no Meta account, no live number. Outbound and media tests stub the Graph
client behind a small interface, so no test reaches the network.

Covered: a valid signature is accepted and a forged one refused; a message is stored once when
delivered twice; a first message with `referral` fills the attribution and a second does not
overwrite it; an unknown `phone_number_id` is ignored without error; a send inside the window
succeeds and outside it is refused; a status callback updates the message it names.

Seeing it live needs a public HTTPS address for the webhook. Locally that is a tunnel to port
3000; on the VPS it is the domain. The address is configuration, so neither is baked in.

## Out of scope

Message templates and broadcasts, Instagram, Telegram, the AI answering, the orders funnel,
voice calls, and reading history from before the connection — the Cloud API delivers nothing
retroactively, and no design can change that.
