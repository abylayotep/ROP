# Instagram Direct Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. All execution and review must use GPT-5.6 Sol.

**Goal:** Receive Instagram Direct conversations in the shared inbox and support operator and AI text replies.

**Architecture:** Keep the existing Facebook Login family and WhatsApp behavior. Add encrypted Instagram account connections, a signed durable webhook intake, channel-aware identities, and a shared delivery boundary for existing conversation consumers.

**Tech Stack:** Existing TypeScript server, Drizzle/PostgreSQL persistence, React frontend, shared contracts, and repository test tooling; Meta Graph API using Facebook Login and a Page access token.

**Spec:** `docs/superpowers/specs/2026-09-12-instagram-direct-design.md`

## Global Constraints

- Execute investigation, implementation, review, and testing on GPT-5.6 Sol.
- Write repository artifacts in English and user-facing chat in Russian; preserve Russian product copy.
- Keep every maintained Markdown file below 500 lines.
- Preserve unrelated working-tree changes and existing WhatsApp behavior.
- Never expose access tokens or OAuth codes through API responses, logs, or browser storage.
- Use tenant-scoped authorization for every owner operation and verify webhook signatures before accepting events.
- Do not invent phone numbers from Instagram identifiers.
- Do not deploy, send real customer messages, or change Meta dashboard settings without explicit authorization.

## Execution notes

Read the spec and applicable `AGENTS.md`/`RTK.md` first. Use existing test helpers and naming conventions. The investigation found a clean working tree and no `.codegraph/`; recheck before edits. The latest observed migration is 0030, so generate the next migration through the repository workflow. Do not commit or publish merely to satisfy a skill checkpoint.

The file map below is anchored in the inspected code. Keep the new delivery module small; update adjacent consumers only to support a real Instagram conversation safely. Resolve exact existing dependency types in each task before introducing new exports.

Verified commands from the workspace root:

```sh
npm --workspace server test
npm --workspace server run typecheck
npm --workspace server run build
npm --workspace rakurs test
npm --workspace rakurs run typecheck
npm --workspace rakurs run build
npm --workspace server run generate
```

Pass test file paths after `test --` for focused Vitest runs. Do not run `migrate` against an unidentified database. Physical `AGENTS.md`/`RTK.md` files were not found during investigation; apply the user-supplied instructions.

### Task 1: Provider-aware persistence and contact contracts

**Files:**
- Modify: `server/src/db/schema.ts`, `packages/contract/index.ts`
- Create: next migration under `server/drizzle/`, generated snapshot/journal entries, migration regression tests using the existing database harness

**Interfaces:** Instagram contacts may have `phone = null` and receive a scoped row in `instagram_contacts`; WhatsApp contacts retain their phone identity. Conversations reference exactly one provider account. Account credentials remain server-only. Public conversation contracts derive channel and display identity without credentials.

- [x] Add failing persistence tests for WhatsApp backfill, Instagram contact without phone, duplicate external identity, cross-provider identity isolation, and exactly-one-provider conversations.
- [x] Add `instagram_accounts`, nullable provider links, account-scoped `instagram_contacts`, and Instagram provider-message deduplication without removing the existing WhatsApp message identifier.
- [x] Generate the migration with the project tooling; inspect SQL for preserved data and backfill ordering.
- [x] Run migration tests on existing WhatsApp fixture data and fresh setup; verify constraints reject invalid rows.
- [x] Propagate contract nullability to consumers with explicit channel branches. Never use non-null assertions to disguise a missing Instagram phone.

Example invariant to encode in the database and regression tests:

```sql
CHECK ((whatsapp_number_id IS NOT NULL)::int
     + (instagram_account_id IS NOT NULL)::int = 1)
```

### Task 2: Meta connection and account health

**Files:**
- Create: `server/src/lib/instagram/messaging-graph.ts`, `server/src/api/instagram.ts`, `server/test/instagram-connection.test.ts`
- Modify: `server/src/api/server.ts`, existing configuration/encryption helpers as required, `rakurs/src/lib/embedded-signup.ts`

**Interfaces:** The Graph client provides injected/testable discovery, permission validation, Page subscription, and text send operations. Owner routes expose safe status, connect with `{code, instagramAccountId?}`, and enable/disable/reconnect. Add these calls to the frontend API in Task 5. Preserve the existing caption-import login mode.

- [x] Write failing tests for encrypted token storage, safe status serialization, ownership, insufficient access, subscription failure, and multiple-account selection.
- [x] Verify current official Facebook Login Send API endpoint and Page subscription behavior; retain verified citations in activation documentation.
- [x] Implement OAuth exchange/discovery with the existing configuration, required permissions, bounded HTTP requests, and sanitized error mapping.
- [x] Validate selected account against discovery results; return safe account choices when ambiguous, and let the client obtain a fresh code for selection if needed.
- [x] Store encrypted credentials and truthful subscription/expiry state. Reconnect updates the same account without deleting conversations; disabling preserves history.
- [x] Run connection tests and confirm access tokens/OAuth codes cannot appear in serialized API errors or logs.

Required messaging scope selection:

```ts
const instagramMessagingScopes = [
  'instagram_basic',
  'pages_show_list',
  'instagram_manage_messages',
  'pages_manage_metadata',
];
```

### Task 3: Shared outbound delivery

**Files:**
- Create: `server/src/lib/messaging/transport.ts`, `server/test/instagram-send.test.ts`
- Modify: `server/src/api/conversations.ts`, `server/src/lib/ai/turn.ts`, `server/src/lib/crm/live.ts`, `server/src/lib/funnel-message.ts`, affected existing test helpers

**Interfaces:** Resolve provider, credentials, recipient, account state, and last inbound customer-message timestamp from an authorized conversation. Expose one text delivery operation and explicit capability checks consumed by all four existing delivery paths. Use repository-native return/error types; return the provider message ID after acceptance.

- [x] Write failing operator/AI send tests that assert Instagram recipient IGSID, Page credential usage, no WhatsApp call, and persistence only after successful delivery.
- [x] Add boundary tests for disabled account, revoked token, missing client message, exactly 24 hours, and delayed sends beyond the window. Inbound client timestamps alone may open the window.
- [x] Replace WhatsApp-only joins with provider-aware loading and implement the shared delivery boundary.
- [x] Route operator, AI, funnel, and CRM/live notifications through the same eligibility checks. Preserve existing WhatsApp transport options and behavior.
- [x] Reject Instagram file sends explicitly; skip unsupported WhatsApp CAPI processing. For phone-dependent payment creation, return a useful missing-phone error rather than passing an Instagram ID.
- [x] Run focused transport tests and existing WhatsApp send/AI/payment regressions.

Window predicate, evaluated immediately before delivery:

```ts
const canReply = lastInboundAt !== null
  && now.getTime() >= lastInboundAt.getTime()
  && now.getTime() - lastInboundAt.getTime() < 24 * 60 * 60 * 1000;
```

### Task 4: Signed webhook and durable inbound processing

**Files:**
- Create: `server/src/api/instagram-webhook.ts`, `server/src/lib/instagram/inbound.ts`, `server/test/instagram-inbound.test.ts`
- Modify: `server/src/api/server.ts`, event schema/migration from Task 1 if generated together, existing event recovery/startup wiring
- Reference: `server/src/api/whatsapp-webhook.ts`, `server/src/lib/whatsapp/inbound.ts`, `server/src/lib/whatsapp/signature.ts`

**Interfaces:** Webhook HTTP intake validates and persists events; a separately callable processor resolves the Instagram account, normalizes the sender/message, and invokes existing conversation advancement and turn scheduling. The worker is recoverable and idempotent using persisted event and provider-message identity.

- [x] Add failing tests for challenge token, raw-body HMAC rejection, unknown account, duplicate message, outbound echo, mixed/unsupported event payload, and retry after a transient processing error.
- [x] Add durable Instagram event storage using the existing event-processing conventions; acknowledge only after persistence succeeds.
- [x] Implement account-based routing and atomic contact/conversation/message creation with Instagram identity.
- [x] Reuse existing `storeLine`, `advanceConversation`, and `runTurns` behavior where compatible; retain existing automation and pause rules. Avoid duplicate AI scheduling on webhook redelivery.
- [x] Represent unsupported inbound attachments explicitly and suppress AI processing that would pretend to understand them. Ignore echoes/status events without extending the reply window.
- [x] Connect recovery to startup or the existing queue mechanism; prove replay creates one message and one turn at most.

### Task 5: Connection UI and channel-aware dialogs

**Files:**
- Modify: `rakurs/src/api/index.ts`, `rakurs/src/screens/IntegrationsScreen.tsx`, `rakurs/src/screens/DialogsScreen.tsx`, `rakurs/src/screens/BoardScreen.tsx`, `rakurs/src/screens/CustomersScreen.tsx`, relevant existing component/API tests
- Modify as required: server list/thread/search serializers and shared contracts from Task 1

**Interfaces:** Frontend receives safe account state and channel/contact identity. Connect invokes messaging-specific login, then the owner connect route. Inbox and CRM consumers render phone or Instagram identity according to channel.

- [x] Add focused UI tests for connect success/failure, account selection, incomplete subscription state, reconnect/disable, and Instagram thread rendering.
- [x] Add a Direct connection card with Russian copy and actionable errors; preserve knowledge import as an independent action.
- [x] Render Instagram identity in dialogs and relevant customer/board surfaces; support search by available display identity.
- [x] Explain closed reply windows and disable unsupported upload controls. Treat backend rejection as authoritative if eligibility changes after rendering.
- [x] Verify narrow and desktop layouts using existing tooling where available, without sending any real messages.

### Task 6: Activation documentation and final verification

**Files:**
- Create: `docs/instagram-direct-setup.md`
- Modify: relevant environment example and this plan's completion status

**Interfaces:** Setup documentation describes the actual implemented routes, environment values, callback verification, permissions, dev/live access prerequisites, text-only behavior, and reconnection flow. No secret values are committed.

- [x] Document Meta account/Page linkage, permissions, OAuth settings, webhook URL/token, Page subscription, app mode/review prerequisites, and a controlled two-account smoke test procedure.
- [x] Run targeted tests across connection, migration, inbound, delivery, and frontend behavior.
- [x] Run repository-prescribed full server/frontend suites and production builds/typechecks; record command results and unresolved failures.
- [x] Review the final diff for tenant isolation, token disclosure, every outbound path's 24-hour guard, queue recovery, and WhatsApp regressions. Fix findings before claiming completion.
- [x] Report code completion separately from real-account activation. List concrete external setup requirements and do not claim live Direct exchange without evidence.

Validation on 2026-09-12: Instagram/automation/CRM focused server tests passed 60/60; the WhatsApp inbound regression passed 15/15. The full server suite passed 1519/1520 tests; its sole failure is the concurrent semantic-funnel task's `paymentEvidence: 'unknown'` expectation in `crm-worker.test.ts`. Server and frontend typecheck/build passed, the frontend suite passed 145/145, `drizzle-kit generate` reports no schema drift, and `git diff --check` passed.

## Coverage self-review

Persistence/compatibility map to Task 1; account access and health to Task 2; every outbound caller, response-window enforcement, and payment safeguards to Task 3; verified durable intake and AI scheduling to Task 4; user-facing identity and controls to Task 5; external activation and regression evidence to Task 6. Historical sync and attachment sending are explicitly out of scope in the spec and are not hidden prerequisites.
