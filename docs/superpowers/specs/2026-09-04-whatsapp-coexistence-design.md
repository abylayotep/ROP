# WhatsApp Coexistence: connecting the number that lives on the phone

**Date:** 2026-09-04
**Status:** Approved. Ready for implementation planning.
**Stage:** 7 of the pleep-model rebuild. Builds on
[WhatsApp Cloud API](2026-09-02-whatsapp-cloud-api-design.md),
[AI agent](2026-09-03-ai-agent-design.md) and [Meta CAPI](2026-09-03-meta-capi-design.md).

## Goal

Let an owner connect the WhatsApp Business number they already use on their phone, without
deleting the app: the AI and the cabinet work in the same chats, an operator keeps answering
from the phone, and the last 180 days of chats and the phone's contact names appear in
Диалоги. This is what pleep offers as «WhatsApp on your phone», and it is Meta's official
*Coexistence* flow: Embedded Signup with `featureType: whatsapp_business_app_onboarding`.

The manual path from stage 2 (paste `phone_number_id`, `waba_id`, system-user token) stays
as the second card, «Отдельный номер». It works today, needs no App Review, and is the
fallback if Meta refuses a number for coexistence.

## Starting point

- One Meta application serves every client: **Tasbaqa**, app id `1585667806534384`, business
  portfolio «ИП Абылай» (`877624983685944`), product WhatsApp added, app published. It is not
  a Tech Provider yet and has no Facebook Login for Business configuration.
- The server pins Graph API `v21.0`; Meta's current guidance is `v26.0`.
- The webhook handles `messages` and `statuses` only. Every delivery is stored raw in
  `whatsapp_events`, answered `200`, then parsed by `processPendingEvents`.
- Production does not exist yet. Embedded Signup needs an HTTPS origin listed in the app's
  allowed domains, so deployment to `rop.tasbaqa.ru` is the first task, not the last.

## Facts from Meta's documentation that shape the design

Verified on developers.facebook.com on 2026-09-04; pages under
`/documentation/business-messaging/whatsapp/embedded-signup/`.

| Fact | Consequence |
|---|---|
| The `code` returned by Embedded Signup lives 30 seconds and must be exchanged server-side with the app secret. | One request does exchange, checks, subscription and sync requests; nothing is deferred. |
| The coexistence finish event is `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING` and its `data` may carry only `waba_id`. | The server resolves the phone number from the WABA when `phone_number_id` is absent. |
| Registration (`POST /{phone}/register`) is **skipped**: the number is already registered on the phone. | No PIN, no register call, no two-step verification handling. |
| Contacts and history are requested with `POST /{phone}/smb_app_data`, `sync_type` `smb_app_state_sync` then `history`. Each may be called **exactly once**, and both within **24 hours** of onboarding. | Requested immediately after connecting, in the same request. A failure is recorded, not retried blindly. |
| History arrives in phases 0/1/2 with `chunk_order` and `progress` 0–100; chunks can arrive out of order; media come as `media_placeholder`, the asset follows only for media ≤14 days old. | Import is idempotent by `wa_message_id`, progress is stored, media placeholders are stored as messages with no file. |
| Declined history arrives as error `2593109`. | Recorded on the number; the screen says the owner turned sharing off on the phone. |
| Messages sent from the phone arrive as field `smb_message_echoes`, array key `message_echoes`. | Stored as outbound messages with `author = 'phone'`. |
| Messages sent through Cloud API are mirrored to the phone app. | Sending from the cabinet needs no change. |
| App-sent messages do not open or extend the 24-hour window. | `last_inbound_at` is not touched by echoes or history. |
| Offboarding comes through `account_update` (`PARTNER_REMOVED`, `ACCOUNT_OFFBOARDED`, `ACCOUNT_RECONNECTED`). Deregister API is not allowed. | The number is disabled on offboard and re-enabled on reconnect; the cabinet has no «disconnect» for coexistence numbers, only a hint to do it on the phone. |
| In development mode the flow works for anyone with a role on the app. App Review and Tech Provider status are required for other businesses. | The first client (Sealhouse) connects before App Review; the review runs in parallel and is not a blocker for this stage. |
| Throughput for dual-use numbers is 20 messages per second. Groups, calls, broadcast lists, catalog and labels are not synced. | Documented as limitations; nothing to build. |

The «number must be 7 days old» rule and the region exclusion list that pleep's wizard
mentions are not in Meta's documentation. The screen does not gate on them.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Two cards, one table | `whatsapp_numbers.connection_kind` distinguishes `manual` from `coexistence` | Sending, media, AI and CAPI already key on the number row; a second table would duplicate every join. |
| Operator answers from the phone | The conversation's `ai_enabled` is switched off | Same rule as an operator answering from the cabinet: a human took the thread. The owner switches it back in Диалоги. |
| Imported history | Same `messages` table, `sent_at` from Meta's timestamp, `last_message_at` moved, `last_inbound_at` **not** moved | Old chats are readable and sortable, but do not open a reply window, do not trigger the AI and do not enter the funnel until the customer writes again. |
| Contact names from the phone | Fill `contacts.name` only when it is null | A name the operator typed in the cabinet is more deliberate than a phone-book entry. |
| Token | Non-expiring business integration token: the Login for Business configuration is created **without** the 60-day option | The manual path already expects a permanent token; a refresh job is a whole feature nobody asked for. |
| Graph version | Bump `GRAPH_VERSION` to `v26.0` everywhere | One constant, already shared with the CAPI client. |
| Sync requests | Fired inside the connect request, results stored on the row | The 24-hour deadline is a cliff; deferring to a job adds a way to miss it. |
| pleep's five-question wizard | Not built | It gates on rules Meta does not document. A short list of requirements above the button says the same in fewer clicks. |

## Meta setup, by hand

Done once by the owner of the Tasbaqa application; the spec lists it because the code is
useless without it.

1. App Dashboard → «Стать поставщиком технологий». Business verification of «ИП Абылай» is
   part of it. While it is pending, the flow works for admins and developers of the app.
2. Facebook Login for Business → Configurations → create from the template «WhatsApp Embedded
   Signup», choosing the variant without token expiration. The resulting `config_id` goes to
   the environment.
3. Login settings: Client OAuth login, Web OAuth login, Enforce HTTPS, Embedded Browser OAuth
   Login, Login with the JavaScript SDK all on; `https://rop.tasbaqa.ru` in Allowed domains
   and Valid OAuth redirect URIs.
4. WhatsApp → Configuration → Webhook: the callback and verify token from the integrations
   screen, then subscribe `messages`, `smb_message_echoes`, `smb_app_state_sync`, `history`,
   `account_update`.
5. Settings → Basic: App ID and App Secret into `deploy/.env`.

## Data model

Migration `0011`:

```
whatsapp_numbers  + connection_kind text not null default 'manual'   -- 'manual' | 'coexistence'
                  + business_id text                                  -- customer portfolio id
                  + sync_requested_at timestamptz                     -- both smb_app_data calls made
                  + sync_error text                                   -- Meta's words if either failed
                  + history_progress integer not null default 0       -- 0..100 from history.metadata
                  + history_declined_at timestamptz                   -- error 2593109 seen
                  + offboarded_at timestamptz                         -- account_update said so
messages.author   gains the value 'phone'
```

`contacts` and `conversations` are unchanged. Messages imported from history and message
echoes use the existing `wa_message_id` unique index for deduplication, which also makes
out-of-order chunks and Meta's redeliveries harmless.

## Backend

### Environment

| Variable | Holds |
|---|---|
| `META_APP_ID` | Needed by the browser to initialise the Facebook SDK and by the server to exchange the code |
| `META_ES_CONFIG_ID` | The Login for Business configuration id |

Both validated at boot with the rest. `deploy/compose.yml`, `deploy/env.example` and
`server/.env.example` gain the two lines.

### Graph client

New methods on `GraphClient`, so the tests keep injecting a fake:

- `exchangeCode(code)` → `GET /oauth/access_token?client_id&client_secret&code`, returns the
  token. The response is JSON with `access_token`; a plain-string body is also accepted.
- `listPhoneNumbers(wabaId, token)` → `GET /{waba}/phone_numbers`, returns id, display number,
  `platform_type`, `is_on_biz_app` for each.
- `requestSmbAppData(phoneNumberId, token, syncType)` → `POST /{phone}/smb_app_data`, returns
  `request_id`.

`getPhoneNumber` additionally reads `platform_type` and `is_on_biz_app`.

### Routes

`GET /api/agents/:agentId/whatsapp/embedded-signup` (owner) → `{ appId, configId }`. The
secret never leaves the server; the browser needs only these two.

`POST /api/agents/:agentId/whatsapp/coexistence` (owner), body
`{ code, wabaId, phoneNumberId?, businessId? }`:

1. Exchange the code. A failure is `400 «Meta не приняла подтверждение: …»` with the secret
   redacted, as `withoutSecret` already does.
2. Resolve the phone: `phoneNumberId` from the body if present, otherwise the single number
   of the WABA; more than one number without an id is `400` asking to retry.
3. Read the number; require `is_on_biz_app = true`. Otherwise `400 «Номер не подключён к
   приложению WhatsApp Business на телефоне»`.
4. `subscribed_apps` on the WABA, same failure text as the manual route.
5. Insert the row with `connection_kind = 'coexistence'`, encrypted token, `subscribed_at`.
   The duplicate handling of the manual route is reused: the same number on the same agent
   is `409`.
6. Request `smb_app_state_sync`, then `history`. Both succeed → `sync_requested_at`. Either
   fails → `sync_error` with Meta's message; the row stays, the response is still `200`, and
   the screen shows the error. No automatic retry: the calls are one-shot on Meta's side and
   a repeat returns an error that would only overwrite a clearer one.

The route returns the number in the shape of the existing `WhatsappNumber` contract type,
extended with `connectionKind`, `historyProgress`, `historyDeclined`, `syncError`,
`offboarded`.

`PATCH` and `DELETE` on a coexistence number: `enabled` still toggles sending from the
cabinet; `accessToken` replacement is refused with `400` (the token comes from Meta, not from
a paste); `DELETE` is allowed and cascades as before. The screen explains that deleting the
row does not disconnect the phone; that is done on the phone.

### Webhook

`applyChange` learns three more shapes, keyed on the change's `field`:

- **`smb_message_echoes`**: for each `message_echoes[]` item, upsert contact and conversation
  on `to`, store the message with `direction = 'out'`, `author = 'phone'`, kind and body as
  for inbound text and media (media ids are downloaded the same way), `status = 'sent'`.
  Move `last_message_at` forward, leave `last_inbound_at`. Set `ai_enabled = false` on the
  conversation. No AI turn is run for the delivery.
- **`smb_app_state_sync`**: for each `state_sync[]` with `type = 'contact'`: `add` upserts the
  contact and fills `name` if null; `remove` does nothing to our data — the customer may still
  write, and we keep what they said.
- **`history`**: for each thread, upsert contact and conversation on the thread id, insert
  every message (`from` equal to the business number → `out`/`phone`, else `in`/`client`),
  `media_placeholder` stored as `kind = 'unsupported'` with body `«Файл из истории телефона»`,
  `sent_at` from the timestamp, status from `history_context.status` lower-cased for outbound.
  Move `last_message_at` forward only. Update `history_progress` to `metadata.progress` when
  larger. An `errors[]` entry with code `2593109` sets `history_declined_at`. A follow-up chunk
  that carries the real media for an earlier placeholder updates that message's file by
  `wa_message_id`.
- **`account_update`**: `PARTNER_REMOVED` or `ACCOUNT_OFFBOARDED` for a known WABA sets
  `offboarded_at` and `enabled = false`; `ACCOUNT_RECONNECTED` clears `offboarded_at` and sets
  `enabled = true`.

History chunks can be thousands of messages. They are inserted in batches of 500 inside one
transaction per chunk, and the event row records how many were stored. The existing
`processPendingEvents` loop already runs after the `200`, so a slow chunk never makes Meta
retry.

An unknown `phone_number_id` on any of the new fields is ignored as today.

### AI and funnel

`runTurns` is unchanged: only inbound `messages` mark a conversation as touched. Echoes and
history never start a turn. The CAPI sweep is unchanged; a purchase is reported only for
conversations with a `ctwa_clid`, which history never carries.

## Frontend

**Интеграции** shows two cards in the WhatsApp block, owner only:

- **«WhatsApp на телефоне»** — three lines of requirements (the number is already in
  WhatsApp Business App, the app is updated, the phone stays online during import), a button
  «Подключить». The button loads `https://connect.facebook.net/en_US/sdk.js` on demand, calls
  `FB.init` with the app id from the setup route and `version: 'v26.0'`, then `FB.login`
  with `config_id`, `response_type: 'code'`, `override_default_response_type: true`,
  `extras: { setup: {}, featureType: 'whatsapp_business_app_onboarding', sessionInfoVersion: '3' }`.
  A `message` listener filters `event.origin` ending in `facebook.com` and
  `type === 'WA_EMBEDDED_SIGNUP'`, keeps `waba_id`, `phone_number_id`, `business_id` from
  `data`; the login callback delivers `code`. Once both are present the screen posts to the
  coexistence route and shows the result. `CANCEL` shows Meta's `error_message` when there is
  one, otherwise nothing.
- **«Отдельный номер»** — the existing three-field form, unchanged.

The numbers list gains: the connection kind, «Импорт истории: 45 %» while it runs and
«История импортирована» at 100, «Владелец выключил передачу истории на телефоне» when
declined, the sync error verbatim when present, and «Телефон отключил API. Подключите заново
на телефоне: Настройки → Аккаунт → Business Platform» when offboarded. The «Обновить токен»
form is hidden for coexistence numbers.

**Диалоги**: messages with `author = 'phone'` are rendered on the operator side with the
label «с телефона». Nothing else changes; imported threads look like any other.

The contract package gains the new fields on `WhatsappNumber`, the `EmbeddedSignupSetup`
type and the coexistence request type.

## Deployment

Before any of this can be tried, the stack goes to the Tasbaqa VPS as a separate Compose
project in `/opt/rakurs`, published by the host's Caddy as `rop.tasbaqa.ru` with `/api/*`
proxied to `127.0.0.1:3000` and the built frontend served as static files. This replaces
`deploy/nginx.conf` for this host; the nginx file stays for a host without Caddy. The
webhook must be verified at the real address before the Meta webhook fields are subscribed.

Deployment is its own task in the plan, with the owner's go-ahead before the shared Caddy
configuration is reloaded.

## Testing

All through the existing fake Graph client and signed webhook payloads; no network.

- Connect: a valid code stores a `coexistence` row, subscribes the app, requests both syncs,
  stamps `sync_requested_at`; a failed exchange stores nothing; `is_on_biz_app = false` is
  refused; a failed `history` request keeps the row and records `sync_error`.
- Echo: stored once when delivered twice, `author = 'phone'`, `ai_enabled` turned off,
  `last_inbound_at` untouched, no AI turn.
- Contacts: `add` fills a null name and leaves a set one; `remove` changes nothing.
- History: two chunks out of order produce the right thread; a redelivered chunk inserts
  nothing new; progress only grows; `2593109` sets the declined stamp; a placeholder is stored
  as `unsupported`.
- Account update: offboard disables, reconnect re-enables.
- Manual route unchanged: its test file passes as it is.

## Out of scope

App Review and Tech Provider approval (a Meta process, run in parallel), token refresh,
group chats, calls, templates and broadcasts, Instagram, pleep's «WhatsApp + calls» card, and
migrating the CAPI screen guidance from `docs/meta-capi.md` onto the screen.
