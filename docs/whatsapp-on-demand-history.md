# On-Demand WhatsApp History

## Scope

Owners can request older messages for the latest 100 or 200 available linked-device
conversations from either Dialogs or Knowledge. Each request asks for at most 50 older
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
