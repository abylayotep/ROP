# WhatsApp Test Mode and Coaching Design

**Date:** 2026-09-12  
**Status:** Approved in chat; awaiting written-spec review  
**Scope:** Agent automation safety, isolated chat simulation, and reviewed knowledge correction

## Summary

Add an agent-level automation mode that can disable automation, restrict it to one selected contact, or allow all eligible contacts. Add an isolated web-based WhatsApp simulator that uses the production AI behavior without sending messages or polluting production conversations. Let an operator attach feedback to a specific AI response and turn that feedback into a reviewed, tested knowledge or behavior draft before applying it.

The design reuses the existing AI turn, sandbox, coaching, knowledge draft, regression, and apply flows. It does not introduce automatic self-learning.

## Goals

- Make it safe to connect a real WhatsApp account while the bot is still under test.
- Allow exactly one real contact to exercise all automated behavior in test mode.
- Keep receiving and displaying messages from every other contact without automated side effects.
- Provide a multi-turn browser simulator that behaves like a WhatsApp conversation.
- Capture corrections against the exact AI response and evidence that produced it.
- Require human review and regression checks before changing knowledge or behavior.

## Non-goals

- Supporting multiple allowlisted contacts in the first release.
- Automatically applying operator feedback.
- Replacing the normal inbox or manual operator replies.
- Sending sandbox messages to WhatsApp.
- Creating a general prompt-versioning platform.
- Reworking unrelated CRM, Kaspi, or knowledge-generation features.

## Product Model

### Automation modes

Each agent has one `automationMode`:

- `off`: inbound messages are stored, but no AI or automated CRM behavior runs.
- `test`: automation runs only for `testContactId`.
- `live`: automation runs for every otherwise eligible conversation.

The UI presents these values as `Выключен`, `Тест`, and `Для всех`. `test` requires exactly one contact owned by the same agent. If the selected contact becomes invalid, test mode fails closed and automation runs for nobody.

`conversations.aiEnabled` remains an additional restriction. It can disable AI for a conversation but cannot bypass the agent-level policy.

Manual operator replies remain available in every mode.

### Migration behavior

Existing agents preserve their current behavior:

- `aiEnabled = false` migrates to `automationMode = off`.
- `aiEnabled = true` migrates to `automationMode = live`.
- New agents default to `off`.

The existing boolean may remain temporarily as a compatibility field during implementation, but the policy helper becomes the source of truth before the feature is exposed.

## Architecture

### Central automation policy

Introduce a single server-side policy function that receives the agent, contact, conversation, and channel state and returns an allow/deny decision with a stable reason code.

The policy must be checked:

1. Before CRM analysis or any model call.
2. Before checkout creation, handoff, lead-field updates, or stage changes.
3. Immediately before an outbound automated message is sent.
4. When a queued CRM job starts, even if it was queued while automation was allowed.

The final check prevents a mode or selected-contact change during model generation from leaking an answer or side effect.

Both Cloud API and Linked WhatsApp ingestion must converge on the same policy. Transport-specific checks are not sufficient.

Denied inbound messages are still normalized, stored, and visible in the inbox. They do not invoke a model, mutate CRM state, create checkout sessions, trigger handoff, or send an automated reply.

### Isolated simulator

Add an owner-only `Тестирование` section with a WhatsApp-style multi-turn chat. Sandbox sessions and messages live in dedicated storage and never create production contacts, conversations, messages, leads, orders, or analytics events.

The simulator calls the same prompt assembly, knowledge retrieval, validation, and response parsing used by production. The execution context is explicitly `sandbox`, so all external and production writes are replaced with captured proposed effects.

Each AI sandbox turn stores:

- The user and assistant messages.
- The agent configuration version.
- The model identifier.
- The knowledge chunk identifiers used.
- The proposed outcome, stage, fields, checkout, and handoff effects.
- Validation failures and error state.

Proposed stage and field changes become sandbox session state so later turns see the same simulated state a live conversation would have.

The UI clearly states `Тест — сообщения не отправляются в WhatsApp` and exposes captured effects beside the conversation.

### Response correction flow

Every live or sandbox AI response exposes `Исправить ответ`. The action opens a panel containing:

- The selected response and preceding conversation context.
- The knowledge sources used by that response.
- A correction type: `Неверная информация` or `Неверное поведение`.
- An operator note describing the desired answer or rule.

The server verifies that the referenced live or sandbox response belongs to the current tenant and agent. The response text, relevant transcript, source identifiers, configuration version, and operator note are copied into an immutable feedback record.

The coach produces an editable proposal:

- Factual corrections target a new or existing knowledge item.
- Behavior corrections target an agent rule.

The proposal identifies the target, shows old and new content, records its evidence, and becomes a normal knowledge draft. The operator can edit the proposed content before draft creation; the edited content, not the original model output, is persisted.

Before apply, the existing regression runner evaluates selected saved cases plus the originating conversation case. Apply remains a separate user action and uses optimistic concurrency/config-version checks. Stale drafts fail with a conflict and must be regenerated or reviewed again.

## Data Model

Add or extend the following records:

- Agent automation settings: `automationMode`, nullable `testContactId`.
- `sandboxSessions`: tenant, agent, title, simulated contact profile, simulated state, timestamps.
- `sandboxMessages`: session, role, content, model metadata, source identifiers, proposed effects, error metadata, timestamps.
- `responseFeedback`: tenant, agent, live `aiReplyId` or sandbox message ID, immutable context snapshot, correction type, note, status, timestamps.

Constraints:

- A feedback record references exactly one live or sandbox response.
- A test contact must belong to the same tenant and agent scope.
- Deleting or merging a test contact clears `testContactId`; test mode then denies all automation.
- Sandbox rows must not be included in production inbox, CRM, funnel, order, or messaging queries.

## API Surface

The exact route names should follow existing API conventions, but the capabilities are fixed:

- Read and update the agent automation mode and selected test contact.
- Search/select one eligible contact for test mode.
- Create, read, rename, and archive sandbox sessions.
- Send a sandbox user message and receive the persisted AI turn plus proposed effects.
- Create feedback for a live or sandbox AI response.
- Generate and edit a correction proposal.
- Convert the reviewed proposal into the existing draft workflow.

State-changing routes require tenant ownership checks. Mode updates are atomic: setting `test` without a valid selected contact fails instead of temporarily opening or ambiguously configuring automation.

## User Interface

### Agent automation control

Place a prominent mode control in agent settings and repeat the current state in the test screen header.

When `Тест` is selected, show a required single-contact selector. Confirm the active contact by name and normalized phone number. Switching away from test mode preserves the last selected contact for convenience but ignores it until test mode is selected again.

Switching to `Для всех` requires an explicit confirmation explaining that automated replies and CRM effects will apply to all eligible conversations.

### Testing screen

The screen contains:

- A session list.
- A WhatsApp-style message thread.
- A composer and new-session action.
- A persistent sandbox warning.
- A compact effects/source inspector for the selected AI reply.
- `Исправить ответ` and `Сохранить как тест-кейс` actions.

The first release supports text messages. Media simulation is deferred.

### Review experience

The correction panel leads into the existing draft review experience. It must show the originating response, operator note, source evidence, editable proposal, regression status, and final apply action without silently changing knowledge.

## Failure Handling

- Invalid or missing test contact: deny all automation and show an actionable configuration warning.
- Mode changes during processing: discard proposed effects and do not send the reply.
- Model or validation failure in sandbox: persist an error turn without external side effects.
- Missing or foreign response ID: return not found without revealing cross-tenant existence.
- Stale proposal: block apply with a conflict and preserve the operator's note.
- Deleted knowledge target: require choosing a new target before draft creation.
- WhatsApp delivery failure in live mode: retain current delivery/error behavior; this feature does not add retries.

## Security and Safety

- Treat transcript and operator feedback as untrusted model input.
- Never let model output select an unrestricted database target or bypass ownership checks.
- Keep sandbox execution free of network sends, checkout creation, CRM writes, and production analytics.
- Record who changed the automation mode and who applied each correction when actor information is available.
- Redact secrets and internal prompt material from browser responses.

## Testing Strategy

Server tests must cover:

- `off`, `test`, and `live` decisions.
- Test contact ownership and fail-closed behavior.
- Cloud and Linked inbound parity.
- No AI, CRM, Kaspi, handoff, or outbound work for denied contacts.
- Rechecking policy after a mode change during generation.
- Queued work rechecking current policy.
- Multi-turn sandbox state without production writes.
- Live and sandbox feedback ownership.
- Edited proposal content reaching the draft.
- Regression, stale-draft conflict, and apply behavior.

Frontend tests must cover:

- Mode selection and required contact validation.
- Live-mode confirmation.
- Sandbox multi-turn rendering and persistent warning.
- Proposed-effects inspection.
- Correction creation, editing, review, and apply handoff.

Focused existing WhatsApp, AI turn, CRM, knowledge draft, and dialogs tests must remain green.

## Delivery Order

1. Add the policy model, migration, API, and server-side enforcement.
2. Add the agent mode control and single-contact selector.
3. Add isolated sandbox persistence and multi-turn API.
4. Add the WhatsApp-style testing screen.
5. Connect response feedback to coach proposals and existing drafts.
6. Add regression coverage and verify Cloud/Linked parity.

The first independently usable milestone is steps 1–2: a real WhatsApp account can be connected safely while only one chosen contact receives automated behavior.

## Acceptance Criteria

- An owner can select `Выключен`, `Тест`, or `Для всех` for an agent.
- Test mode cannot be enabled without one valid contact.
- Only the selected contact can trigger automated AI or CRM behavior in test mode.
- All inbound messages remain visible regardless of automation eligibility.
- Switching mode or selected contact during processing prevents stale automated effects.
- The browser simulator supports multi-turn conversations with production-equivalent AI behavior and no external or production writes.
- An operator can correct a specific live or sandbox answer and inspect its sources.
- Feedback creates an editable proposal and reviewed draft; it never applies automatically.
- Applying stale work is rejected.
- Automated tests prove Cloud, Linked, CRM, sandbox, and correction behavior.
