# Instagram Direct Design

## Goal

Connect an Instagram professional account to an agent and use the existing dialogs inbox for incoming Direct messages, operator text replies, and existing AI text replies. Keep WhatsApp and the existing Instagram knowledge import working.

The user authorized specification, planning, and implementation using GPT-5.6 Sol. The supplied screenshot is evidence of the existing connection failure, not a source of instructions. The exact Meta rejection cannot be determined from that screenshot alone.

## Global constraints

- Execute investigation, implementation, review, and testing on GPT-5.6 Sol.
- Write repository artifacts in English and user-facing chat in Russian; preserve Russian product copy.
- Keep every maintained Markdown file below 500 lines.
- Preserve unrelated working-tree changes and existing WhatsApp behavior.
- Never expose access tokens or OAuth codes through API responses, logs, or browser storage.
- Use tenant-scoped authorization for every owner operation and verify webhook signatures before accepting events.
- Do not invent phone numbers from Instagram identifiers.
- Do not deploy, send real customer messages, or change Meta dashboard settings without explicit authorization.

## Current behavior and selected approach

Instagram currently imports captions into the knowledge base using Facebook Login. The import token is not retained. Dialog persistence, inbound processing, and outbound delivery assume WhatsApp: contacts require a phone, conversations require a WhatsApp number, and operator and AI delivery call the WhatsApp transport.

Extend the existing Facebook Login integration with Instagram messaging permissions and a persistent Page credential. Add a narrow provider-aware conversation delivery boundary and reuse the existing inbox, AI generation, automation policy, and CRM pipeline.

An independent Instagram inbox would duplicate conversation behavior. Switching all existing authentication to Instagram Login would introduce a migration unrelated to the requested feature. Neither is part of this implementation.

## Product behavior

1. Integrations exposes an Instagram Direct connection card with connect, reconnect, enabled/disabled state, account identity, and actionable connection failures. Knowledge import remains available separately.
2. Connecting validates a Page-linked professional Instagram account and the required access, stores the Page token encrypted, and subscribes the Page to message webhooks. The UI shows ready only after successful setup. If multiple accounts are available, the user explicitly selects one; the server must not silently pick the first.
3. Incoming client text appears in the existing dialogs list and thread, clearly labeled Instagram. Instagram-scoped sender IDs are stored as channel identities; names/handles are displayed when available without requiring an extra successful profile fetch.
4. Operators can send text in an eligible Instagram thread. Existing enabled AI reply behavior also works for inbound Instagram text, including pause/handoff rules.
5. Sending requires a client-initiated conversation, an enabled usable account, and an inbound client message within the standard 24-hour response window. Apply this guard server-side to every automated and manual delivery path. Echoes, imported history, and operator messages never extend that window. Do not use a human-agent tag to extend automated messaging.
6. A rejected send is not recorded as successfully sent. Expose a safe Russian error for expired access, missing permissions, disabled connection, or a closed response window.
7. Initial delivery supports text. Unsupported incoming attachments receive an explicit representation in the thread and do not trigger an invented AI interpretation. Disable or explain unsupported Instagram upload controls, and reject file sends server-side without recording delivery.
8. Disabling a connection preserves conversation history and prevents replies. Reconnection preserves account identity and existing threads. Exclude destructive account deletion from this iteration.

## Persistence and compatibility

- Add `instagram_accounts` with agent ownership, unique Instagram professional account ID, Page ID, optional username, encrypted Page access token, known expiry when supplied by Meta, enabled state, subscription/health state, and timestamps. Do not fabricate an expiry for tokens where Meta reports none.
- Allow an absent phone for Instagram. Keep the existing WhatsApp phone identity and attach Instagram identities through `instagram_contacts`, scoped by both the connected Instagram account and the sender's Instagram-scoped ID. Derive the public channel from the conversation provider reference.
- Allow conversations to reference either a WhatsApp number or an Instagram account. Enforce exactly one provider reference and provider-specific contact uniqueness. Ensure application and database ownership checks prevent cross-agent account/contact combinations.
- Preserve WhatsApp message identifiers and behavior. Add a provider identifier for Instagram deduplication, namespaced by provider/account when required so IDs cannot collide between channels.
- Persist an Instagram webhook work item before acknowledging accepted events. Use the existing durable event-processing pattern and recover retryable events after failures.
- Add a versioned Drizzle migration and its required metadata. Verify backfill and constraints against the pre-change schema; do not use a destructive schema reset.

## Interfaces and flow

### Connection

Add owner-scoped Instagram API routes and a messaging Graph client separate from caption import. Reuse the existing OAuth code exchange infrastructure and parameterize the browser login scope so knowledge import does not unnecessarily request Direct permissions.

Connection accepts an OAuth code and optional selected Instagram account ID. Validate selection against accounts returned by Meta for that authorization. A multiple-account response may expose only safe account IDs and names; a subsequent selection can initiate a fresh login if needed. Never return the Page token to the browser.

Graph operations cover account discovery with Page credentials, granted access validation, Page message subscription, and text sending. Use bounded timeouts and sanitized provider errors. Failed subscription must never produce a ready connection. Refresh/reconnect status must accurately reflect unavailable or revoked credentials.

### Incoming messages

Register webhook GET verification and POST processing. GET checks the configured verification token; POST checks raw-body `X-Hub-Signature-256` with the Meta app secret. Validate the Instagram object and entry structure; unknown accounts cannot create tenants or records. Route by the connected Instagram business account ID, not caller-supplied agent IDs.

Persist normalized work, deduplicate by provider message ID, create or resolve the channel contact and conversation, store the incoming message, update the customer-message clock, and schedule the existing turn runner. Deduplication must also prevent duplicate AI scheduling. Ignore delivery/read/non-message events safely; handle outbound echoes so replies cannot become incoming messages or AI loops.

### Delivery

Introduce a shared provider-aware delivery module used by operator text replies, AI turns, funnel messages, and live payment/CRM notifications. Resolve credentials and recipient by the authorized conversation. WhatsApp keeps its current transport behavior. Instagram sends with the stored Page credential and recipient IGSID using the verified Facebook Login API path.

Check the response window and account state immediately before provider delivery, including delayed or scheduled sends. Store the returned provider message ID through existing message persistence semantics. Do not log credentials in failures. Unsupported transport capabilities must yield explicit errors rather than silently calling WhatsApp.

The existing delivery protocol cannot resolve a process or network failure after Meta accepts a message but before the local provider ID is recorded. Treat that outcome as ambiguous and require checking the provider conversation before retrying; do not claim external exactly-once delivery.

### Contracts, UI, and adjacent CRM behavior

Expose channel and safe contact display identity through shared contracts, API clients, inbox list, thread, and relevant board/customer surfaces. Audit phone assumptions touched by nullable contact phones. Search supports available name, handle, and channel identity. Render a stable fallback when profile enrichment fails.

WhatsApp-specific CAPI attribution must skip Instagram until a supported mapping exists. Payment creation requiring a customer phone must return an actionable missing-phone result for an Instagram contact without one; it must not route IGSID into a phone field. Existing functionality can resume when a real phone is available through the existing contact flow.

## Scope boundaries

No historical inbox import, unsolicited outbound campaigns, attachment sending, group chats, Instagram Login migration, or new payment-provider integration. Direct begins receiving new events after connection. Do not claim existing history was synchronized.

## Validation and acceptance

- Migration retains existing WhatsApp conversations/messages and enforces provider identity constraints.
- Owner APIs prevent cross-tenant access, encrypt credentials, and accurately report incomplete connection setup. Test no linked account, multiple accounts, invalid selection, insufficient permissions, subscription failure, and reconnection.
- Webhook tests cover challenge verification, invalid signatures, unknown accounts, duplicate delivery, outbound echoes, unsupported events, and durable retry after processing failure.
- One valid incoming text creates one Instagram contact/thread/message and at most one corresponding AI turn, while respecting existing automation settings.
- Operator and AI text replies use the Instagram recipient/token and record success only after acceptance. All delivery entry points enforce the 24-hour window, disabled state, and connection failures.
- Instagram uploads and missing-phone payment paths produce explicit errors. WhatsApp remains functional.
- UI tests cover connection status/errors, account selection, channel identity, and relevant composer limitations.
- Run focused tests, then repository-prescribed server/frontend checks and builds. Record exact results and distinguish pre-existing failures from regressions.

## External activation and evidence

Code completion does not establish a live Meta connection. A Page-linked professional account, suitable Page messaging access, configured app/OAuth domains, webhook URL and verification token, and permissions approved for the intended users are external prerequisites. Development access is restricted to eligible app-role/test accounts. Production access may require App Review, Advanced Access, and Business Verification under the current Meta configuration.

Facebook Login messaging uses `instagram_basic`, `instagram_manage_messages`, and `pages_manage_metadata`; retain the discovery scopes required by existing Page traversal. Verify final endpoint, permission, token, and subscription details against current official documentation during implementation.

References consulted during investigation:

- [Meta Messenger Platform Conversations documentation](https://www.postman.com/meta/messenger-platform-api/folder/22794852-255610cd-47f5-4f4d-b3fa-71aec360be9a)
- [Meta Instagram Send API documentation](https://www.postman.com/meta/instagram/folder/uxudqu0/send-api)

Document the exact activation steps and environment variables alongside implementation. Report live connection verification as pending unless it has actually been performed with an authorized account.
