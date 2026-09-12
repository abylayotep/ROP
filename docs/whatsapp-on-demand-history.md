# On-Demand WhatsApp History

## Scope

Owners can request older messages for the latest 100 or 200 available linked-device
conversations from Knowledge. Dialogs links to this workflow. Each request asks for at most 50 older
messages per chat. The API selects only enabled, currently connected numbers owned by
the requested agent, with a real stored WhatsApp message as the history anchor.

This is not an export of the phone's entire chat list. If initial history has never arrived
and there are no known messages, the request returns an actionable error. It never
disconnects, clears credentials, or claims that a reconnect downloads unknown chats.
Cloud API numbers are not included in this linked-device operation.

## API and status

- `GET /api/agents/:agentId/whatsapp/history`: members can read live availability and the
  current request status.
- `POST /api/agents/:agentId/whatsapp/history`, body `{ "limit": 100 }` or
  `{ "limit": 200 }`: owners only; an active request is reused, not duplicated.
- Status distinguishes requesting, waiting, completed responses, partial responses,
  and failure. A send acknowledgement is not a history response.
- Response correlation uses the peer-data request ID and linked number. Counters describe
  raw messages received from WhatsApp, not successfully persisted unique rows. The UI
  explicitly distinguishes the two; existing history import performs storage/deduplication.
- Request tracking is in memory, bounded to 500 retained runs. Restart clears tracking,
  but does not erase already saved conversations or messages.
- Sending has a ten-second deadline per request and a five-minute overall job budget.
  After dispatch, unanswered history requests time out after ninety seconds. Early
  correlated responses are retained briefly as bounded metadata, without message bodies.

## Knowledge and script preparation

The knowledge panel can select the latest available 100 or 200 conversations. It processes
saved messages within the selected date range through the existing preview and reviewed
draft flow. It does not automatically publish facts, rewrite an agent's rules, or send
messages to customers.

The conversation cap is now 200; all other AI limits remain unchanged: 5,000 eligible
messages, 200,000 input characters, 20 first-attempt batches, and the existing cost/retry
controls. A large selection can therefore require a narrower date range or fewer chats.

## Display refresh

Dialogs, the selected thread, history status, and the knowledge conversation list refresh
every five seconds while visible. Requests do not overlap. Returning to the tab refreshes
immediately; leaving the screen aborts the fetch and removes timers/listeners. Manual
refresh does not request older history. Existing data and unsent replies survive background
refreshes, and the thread follows incoming messages only when already near its bottom.

## Browser verification

An isolated local fixture uses fake WhatsApp and AI clients, not production credentials.
The history button requested a conversation, received a correlated response, and stored
the synthetic historical message. It appeared in Dialogs and in the knowledge preview.
A later synthetic inbound message appeared without navigation or manual reload; the typed
reply remained unchanged. Selecting 200 with only one available conversation selected
that one conversation; it did not invent the missing 199.

Production receipt of old history is a separate external verification and is not implied
by these fixture results.

## Release gates

- Final immutable server run: 99 files, 1,325 tests passed, exit 0, 205.96 seconds,
  using the dedicated local `rakurs_generation_t3_test` database.
- Frontend: 15 files, 100 tests passed. Both production builds and typechecks passed.
- Astra re-reviewed request deadlines, early-response correlation, and stale-job identity
  fixes with no remaining blocker. An earlier full test run overlapped the red/green
  regression edits and is explicitly not the final gate.
- Protected database/frontend backups and the previous API image were retained before
  switching. This release requires no schema migration.

## Production rollout

Release code: `ab0f466`. API and frontend were switched after the final gates.
API image: `sha256:ff35c1a72a0f8cca3b0ee52c3662bb4aecae5c422bd5ae2f4a475a92a9de80d1`.
Frontend entry SHA-256: `fad89fa61505d5f7f6872449543a89b6af0f484b8727319053a7b6d80132d375`.
The running image and public entry matched; API health passed and restart count was zero.

The signed-in production UI showed one live linked number and one available conversation.
The database independently contained one conversation and three real inbound messages
(sent between `2026-09-12T01:19:39Z` and `01:20:09Z`). Thus live reception now has evidence,
unlike the earlier zero-message baseline.

The owner-authorized history button was exercised with limit 200; only the one available
conversation was requested. WhatsApp returned no correlated history response within the
90-second response budget. The UI displayed the timeout as a failure and re-enabled retry.
This proves the deployed request/status flow, not successful retrieval of older history.
Historical delivery remains unresolved. No production AI generation, customer-facing
message, logout, or credential reset was performed for this check.

## Append delivery repair (2026-09-12)

The socket previously discarded every `messages.upsert` event of type `append`.
These events now enter the existing history importer instead of the live response path.
This preserves replayed messages without sending automatic replies or reopening reply windows.
It does not force WhatsApp to respond to an on-demand request.

Request diagnostics now expose only lifecycle enums and counters, never chat identifiers,
message bodies, session identifiers, or raw errors. Logging failures cannot interrupt import.
Five focused suites passed: 61 tests, plus server typecheck and production build.
The initial sandboxed database run was blocked by EPERM; the authorized local test run passed.

Deployed image: `sha256:be84c50ee0386d563b396d607f8edcb6918923d3892f887aa5fe1b677add693d`.
Rollback tag: `rakurs-api:before-append-history-fix`. No migration or credential reset.
API health passed; the linked number reopened. Four real messages remained in storage.
The signed-in production UI retried the 200-chat request after deployment. One available
chat was requested; the lifecycle recorded `sent`, then `finished/failed` with zero responses
after 90 seconds. The UI showed the same failure. No history import event was recorded.
The append repair is verified, but retrieval of old history remains unresolved.

## Safe re-pairing (2026-09-12)

Owners can use `POST /api/agents/:agentId/whatsapp/linked/:numberId/reconnect` and the
Integrations re-pair card to issue a new QR for an existing linked number. The number ID,
conversations, and messages remain. Expiry or startup recovery marks an existing number
logged out instead of deleting it; only never-paired `pending:` placeholders are removed.
The stream uses the new attempt's deadline, not the original number creation time.
Cancelling leaves the existing number disconnected and retains its correspondence.
The socket verifies the saved phone identity before accepting a re-pair's data.
Retry timers check current enabled/state values so cancelled attempts are not revived.

Verification: seven server suites, 99 tests passed; frontend 101 tests passed; both builds
and server typecheck passed. No database migration. Rollback image tag:
`rakurs-api:before-safe-repair`; previous frontend entry is stored privately in
`/opt/rakurs-backups/20260912-safe-repair/index.html` on the deployment host.
Primary-phone scanning and subsequent history delivery still require live verification.

## Initial delivery and LID mapping repair

After the owner scanned the new QR, production reported `open`, history progress 100,
2,876 raw messages and 79 contacts. The importer skipped 2,820 messages with unresolved
LID peers; only six message rows in two conversations were present. Progress 100 therefore
does not mean complete persistence. The raw skipped chunk was not durably retained.

The adapter now retains chat `pnJid`/`lidJid` metadata. Before importing messages, the
history handler learns phone/LID pairs from chats and contacts. Incoming history without
`senderPn` can use this number-scoped directory, just as outgoing history already did.
Opaque LIDs are never treated as phone numbers. Four focused suites passed, 49 tests,
plus server typecheck/build. Deployed image:
`sha256:88c625453b896d4f3ddd66eb6bb30afa5faf388a5efd908ab766208e4c6b2694`.
Rollback tag: `rakurs-api:before-history-lid-mapping`. API health passed.
Another history delivery is needed to recover previously skipped messages.

The owner selected the latest two weeks for knowledge/script preparation: local dates
2026-08-30 through 2026-09-12 inclusive (`to` is exclusive 2026-09-13).
The selection screen was set to that range; no AI processing or publication was started.

## Durable history inbox (2026-09-12)

Migration 0022 adds number-scoped persistent LID mappings and an encrypted packet inbox.
The socket captures protobuf history notifications; the worker stores downloaded raw
protobuf before decoding or importing. Unlike the processed Baileys event, this retains
the complete `phoneNumberToLidMappings` table. Baileys still processes its own copy to
preserve initial app-state synchronization, but that lossy event does not write messages.
Capture is asynchronous; a database failure before the notification commit is logged,
not acknowledged as a successful archive. This cannot recover packets discarded earlier.

AES-GCM binds each ciphertext to its number, packet ID and field. Payloads and download
notifications expire after seven days; expiry does not remove imported messages.
Queued work survives restarts. A stale processing lease is retried after 30 minutes.
Raw storage precedes a transaction containing message import and result counters.
Historical messages never enter the live AI reply pipeline.

The knowledge screen lists the latest 50 packets and their last-pass counts: received,
saved, duplicate, excluded and unresolved. Owner-only replay is tenant-scoped and rejects
expired or currently processing packets. Partial packets require explicit replay after
missing mappings arrive. Replay uses saved raw bytes and does not require a new QR.
The periodic metadata query never loads packet ciphertext.

The production backup preceding this release is stored privately at
`/opt/rakurs-backups/20260912-durable-history/`; rollback image tag is
`rakurs-api:before-durable-history`. The additive tables can remain during rollback.
Before release, the real account still had six messages in two conversations. No claim
of recovered old history or generated knowledge is made without a new delivery check.

Release verification: 117 focused server tests and 103 frontend tests passed; server
typecheck and both production builds passed. The deployed API image is
`sha256:899bd75f241862605bfc4ee6ac8366fee7eaf595dc13a6f1cb7f03cc4dd68713`;
the frontend entry loads `index-B1KPM9mg.js`. Both private and public health checks passed.
The real browser showed the default 14-calendar-day selection, an open linked connection,
and two available chats. A live on-demand request was sent to those two known chats.
It timed out with zero responses and two failed targets; the archive remained empty.
Existing six messages were preserved. Recovering the earlier skipped history still needs
a fresh initial delivery from the phone. No additional QR or AI generation was started.

## Simplified two-week preparation

The main knowledge screen uses all returned conversation IDs and the latest 14 local
calendar days, including today. No 100/200 slicing or manual checkbox selection occurs.
A no-model preview refreshes once a minute and reports selected, eligible and skipped
messages. Failed, empty or truncated previews cannot start paid generation. Technical
details and history transport controls are collapsed; the main action prepares drafts.

The batch-count cap is 200, matching the existing 200-conversation bound. Other input
caps remain: 5,000 eligible messages and 200,000 characters. This permits many short
conversations without silently dropping them. The real 78-chat selection previously
exceeded the old 20-batch cap despite containing less than 80,000 raw text characters.

Extraction separates seller-supported facts (`База знаний/`) and sales wording (`Скрипт/`).
A successful run assembles at most two review drafts without applying notes or rules.
Missing categories are reported, never fabricated. Same-path proposals share one draft
operation while retaining their source mappings. Run detail returns draft links across
all proposal pages, so the second category cannot disappear behind pagination.

Verified release: 48 focused server tests and 109 frontend tests passed, both builds and
server typecheck passed. API image:
`sha256:b5df8d0f95ff728f675d32b0938b6afc49dd1b2591be857735f3dbca1231aa99`.
Frontend entry: `index-208rgeMO.js`. No new migration. Backup directory:
`/opt/rakurs-backups/20260912-simple-knowledge/`; rollback tag:
`rakurs-api:before-simple-knowledge`.

Cold startup exceeded the initial health retry budget; logs then showed successful
listening, and both private/public health checks passed before frontend activation.
The real browser preview covered 78 conversations and 2,808 messages for August 30 through
September 12 inclusive. Eligible: 1,883; skipped: 256 unsupported, 653 empty, 15 sensitive,
one without a seller response. It required at most 80 model calls, with no truncation.
The single preparation button was enabled; no paid generation or publication was started.
