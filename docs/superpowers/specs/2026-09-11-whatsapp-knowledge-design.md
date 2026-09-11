# WhatsApp History to Reviewed Knowledge

Status: implementation specification. Planning owner: GPT-6 Astra. Implementation workers: GPT-5.6 Sol.

## Outcome and scope

An owner sees the WhatsApp history actually stored for their agent, selects conversations and dates, runs bounded extraction, reviews source-backed suggestions, and publishes approved knowledge through the existing draft workflow. Existing knowledge remains usable throughout.

The release also improves knowledge-screen usability and Meta Conversions API setup guidance. Instagram `Invalid Scopes` is a separate evidence-led investigation; private app configuration is not assumed.

## Observed baseline

- Backend: Fastify, TypeScript, Drizzle/PostgreSQL, injected OpenRouter `ModelClient`; frontend: React/Vite; shared contract: `packages/contract/index.ts`.
- Cloud history is stored by `server/src/lib/whatsapp/history.ts`; linked history by `server/src/lib/whatsapp/linked/history.ts`. Both populate ordinary conversations/messages.
- Cloud import deliberately leaves `lastInboundAt` unchanged. The inspected linked import called `advanceConversation(..., !line.fromMe)`, advancing that live-reply timestamp for incoming history. Sol has now changed the historical call to `false` with a focused RED/GREEN regression and passing server typecheck. The complete history suite is not yet green: shared-database truncation caused interference.
- Imported linked messages are marked `phone` or `client`; media references are stored for lazy downloads. Do not fetch media for extraction.
- Existing knowledge writes use `saveNote`, rebuilding sections and links. Existing `kb_drafts` support `note_create` and `note_update`, stale checks, test runs, and atomic apply with one configuration-version bump.
- Draft apply requires a completed test run at the current configuration version. Generated proposals must preserve this gate.
- Existing local changes cover responsive UI and request/login cancellation. Preserve them. Concurrent work in `.claude/worktrees/obsidian-knowledge-base-f66bf4` owns linked `client.ts`, `inbound.ts`, `normalize.ts`, `lid-directory.ts`, and related tests. Inspect read-only; integration follows that worker's completion.
- No `.codegraph/` directory was present during this inspection. No indexing is requested.

## Global constraints

- Planning and specification use GPT-6 Astra; implementation subtasks use GPT-5.6 Sol.
- New repository artifacts are English; product strings and user communication are Russian.
- Each maintained Markdown file stays under 500 lines.
- Preserve existing user edits and coordinate shared files before editing.
- Database tests run only against a verified disposable test database; `withDb()` truncates tables.
- No production deployment, credential changes, or concurrent-worktree merge is part of a worker task.
- Reuse installed dependencies; do not introduce a queue service or new AI provider.

## History behavior

History ingestion may insert/update stored messages, contacts, history progress, and monotonically advance `lastMessageAt`. It must not open a reply window, run an AI turn, enqueue a send, change funnel stage, or emit conversion events. Test both a new conversation and history arriving on an existing live conversation. Redelivery must not duplicate messages.

Keep transport-specific availability honest: zero progress is not proof of failure, and completion is not proof that every historical phone message was supplied. UI distinguishes waiting for history, receiving history, provider-reported completion, declined sharing, and disconnected/error states using observed data. Unknown state remains unknown. No promise of a complete phone backup or arbitrary backfill.

Conversation ordering is stable by `sentAt` then message ID. Sources must navigate to the cited message, including older pages, rather than only opening the newest messages in a thread.

## Owner flow

1. Open knowledge and choose `Собрать базу знаний из чатов`.
2. Select a UTC-normalized date interval (displayed in the browser's local time) and one or more conversations. Default interval is the last 30 days; no conversations are selected automatically.
3. Preview eligible and skipped counts, model, batch/call upper bound, and any truncation. Explain that selected, redacted text goes to the configured AI provider. Missing AI configuration blocks starting with a link to settings.
4. Start once. Return an asynchronous run ID immediately; show completed batches, proposal count, token usage, actual reported cost, and error/cancel state. Reload recovers the run by ID.
5. Inspect proposals with dates, source snippets, existing-knowledge matches, and uncertainty/conflict warnings. Edit, reject, or select proposals for a draft. Nothing is selected automatically.
6. `Создать черновик` creates one existing-style draft with only explicitly selected proposals. Open the existing comparison/test screen. Required tests and then `Применить` publish through the existing atomic apply route.
7. Applied notes retain source provenance. Repeating the same request or conversion does not duplicate the run, draft, or note.

Owners can preview, start, cancel, retry, edit, reject, and create drafts. Members receive the same read access they have to ordinary knowledge/conversations, but cannot mutate generation or publish. Every endpoint enforces this server-side.

## Selection and bounded analysis

V1 analyzes stored text and text captions only, with at least one seller-authored `phone` or `operator` message per batch. Customer messages provide question context only. Exclude `ai` and `system` authored text as factual evidence, unsupported/media placeholders, group/status traffic, and empty text. No transcription, OCR, external fetch, or attachment download.

Hard limits per run: 100 conversations, 5,000 eligible messages, 200,000 input characters before prompt framing, 20 batches, 10,000 text characters and 100 messages per batch, 20 proposals per batch. A single message over the batch text cap is skipped and counted; do not split an assertion silently. Each batch contains one conversation, chronological chunks, with no duplicated paid overlap. Boundary fragments without seller evidence yield no proposals.

Preview freezes selected message IDs, content hashes, ordering and batch boundaries in a manifest. Starting revalidates ownership and content hashes; changed/deleted source rows require a refreshed preview (409). Selection exceeding any limit is refused with counts and a request to narrow it; never silently sample. A preview expires after 15 minutes and does not make AI calls.

One active run per agent, enforced in PostgreSQL, and one batch call at a time per run. Use the existing shared turn-slot limiter with bounded acquisition; failure to obtain a slot within 60 seconds pauses with a retryable error. Pin configured model and temperature at start. Store no provider key in run records.

Add optional `maxTokens` to `CompletionInput` and serialize it as `max_tokens` only when supplied. Generation sets 2,000 output tokens and keeps the current provider timeout. Thus a fresh run makes at most 20 calls; prompt overhead is fixed and text caps are enforced before sending. Record actual `promptTokens`, `completionTokens`, and `cost`. Show currency estimates only when a verified price is available; never invent a dollar maximum from character counts.

No automatic model retry. Explicit retry resumes only failed/unstarted batches, preserves successful batches, and warns that an interrupted or timed-out call may already have been charged. Bound each batch to two attempts total; beyond that use a fresh owner-started run. Replaying a completed request uses its existing result.

Cancellation stops admission of further calls. V1 may let the already-started call finish within its deadline; record its reported usage but discard proposals if cancellation won the state transition. Explain `Отмена после текущего запроса`; never claim an in-flight charge was prevented.

## Extraction and privacy rules

Treat chat content as untrusted data, never system instructions. Use structured JSON parsing and Zod validation. The prompt asks for reusable product information, payment/delivery/return policies and frequently answered questions, each grounded in one or more seller messages. Preserve qualifications and dates; do not turn an individual discount, negotiated promise, or customer assertion into universal policy.

Before model submission, remove participant names/phone metadata; redact phone numbers, emails, account/card identifiers and detected customer addresses/order identifiers from text. Omit messages where usable business facts cannot be separated from sensitive details. Do not claim perfect automated anonymization; the preview explains this limitation. Revalidate generated text for these patterns and reject unsafe output before storing proposals. No raw transcript in application logs, provider error logs, or job error fields.

Each validated proposal has `path`, `body`, one or more source message IDs belonging to the current batch, and zero or more warnings (`dated`, `conflict`, `context_limited`). Reject invented/cross-agent citations and proposals supported only by a customer. Do not expose arbitrary model-supplied URLs as source links.

Detect exact duplicates with a normalized-content fingerprint within an agent and compare against existing note content. Similarity matches are suggestions for the owner, not automatic overwrite decisions. Contradictory proposals remain visibly separate. An existing-note update requires the owner to choose the target and its current version is captured by `baseOf`.

## Storage and concurrency

Add `kb_generation_previews`, `kb_generation_runs`, `kb_generation_batches`, and `kb_generation_proposals` to the existing Drizzle schema with a generated next migration and journal entry. Do not hard-code a migration sequence while another worker may generate one.

- Previews: agent/user IDs, selection manifest, batch boundaries, counts, creation and expiry timestamps. Never occupy the active-run index. Delete expired previews during preview creation; runs retain their own frozen manifest.
- Runs: agent/user IDs, client request key, selection manifest (IDs/hashes, never raw bodies), pinned model/temperature, status, cancellation timestamp, aggregate usage/cost, sanitized error code, created/updated timestamps. Unique `(agent_id, request_key)` and partial unique active-run index.
- Batches: run ID, ordinal, source IDs/hashes, status, attempt count, usage/cost and sanitized error. Unique `(run_id, ordinal)`. Transition `pending → running → done|failed`; skipped/cancelled batches never claim completion.
- Proposals: run/batch IDs, normalized fingerprint, reviewed path/body, warnings, structured source IDs, status, optional draft ID/op index and applied note ID. Unique `(run_id, fingerprint)`; states `pending`, `rejected`, `drafted`, `applied`. Revision counter protects concurrent edits.

Run states: `queued → running → completed|failed|cancelled`; retry moves a failed run back to queued under its existing ID. Completed includes zero proposals with an explanation. Retain successes after partial failure. On startup, mark orphaned queued/running work failed with `interrupted`; do not resume paid calls automatically. This follows the existing single-process application pattern; multi-instance durable workers are outside V1.

Draft conversion locks selected proposals and creates draft bookkeeping in one transaction. A repeated identical request returns its draft ID; proposals already assigned to a different draft yield 409. Editing a drafted proposal is refused; discard its draft first, then explicitly return eligible proposals to review. Never mutate ops under a recorded test run.

Reuse draft `origin: 'manual'`; association tables identify chat provenance without changing unrelated origin unions. Extend internal `applyOps` with an optional callback/result mapping for created note IDs. Existing callers may ignore it. Record proposal-to-note links inside the same apply transaction, preserving config-version and stale gates. Keep provenance outside model-searchable note body; source views join it by note ID. Source deletion yields `Источник недоступен` and no cached raw transcript; agent deletion cascades generation data.

## API contract

Base: `/api/agents/:agentId/knowledge/generation`.

- `POST /preview`: `{ conversationIds, from, to }` → `{ previewId, expiresAt, counts, batchCount, modelId, maxCalls, maxOutputTokens }`; owner only; no model call.
- `POST /runs`: `{ previewId, requestKey }` → run summary, 202 (existing identical key returns existing run; different payload under same key returns 409).
- `GET /runs?cursor=` and `GET /runs/:runId`: summaries/progress, paginated proposals, usage and safe errors; authorized agent reads only.
- `POST /runs/:runId/cancel` and `/retry`: owner-only idempotent transitions; retry rejects exhausted attempts.
- `PATCH /proposals/:proposalId`: `{ revision, path?, body?, status?: 'pending'|'rejected' }`; validate existing note length/path rules; 409 stale revision.
- `POST /runs/:runId/draft`: `{ proposalIds, revisions, updateTargets? }` → `{ draftId }`; 1–20 proposals, explicit IDs, no implicit all-selection.
- Extend note detail with structured source references and authorized source resolution; pagination and source-message anchoring use the existing conversation API.

All nested IDs are resolved under the route's agent; inaccessible objects return 404, member mutations 403, invalid selection 400, concurrent/stale requests 409. API keys remain server-only.

## Independent Meta work

CAPI guidance explains the existing dataset/pixel ID, access token, test code and enablement fields, links to official setup pages, and distinguishes local configuration from successful provider acceptance and appearance in Events Manager. Test-event dispatch is an explicit UI action using synthetic data; editing help text must not emit an event. Verify current Meta documentation before changing instructions.

Instagram investigation records the exact OAuth flow, requested permissions, app type/configuration evidence and sanitized provider response. Compare only with official current Meta documentation. Local cancellation fixes are separate from provider permission configuration. Change permissions only when the actual supported flow is established; unavailable dashboard evidence is a precise unresolved dependency.

## Acceptance and release gates

1. Imported history is visible, idempotent and sorted; it cannot cause replies, live-window changes, funnel changes, or CAPI activity.
2. Foreign-agent selections/citations/runs/drafts are inaccessible; member writes fail.
3. Fake-model tests cover source validation, malicious chat instructions, PII patterns, malformed output, limits, duplicates and zero results; no live model calls in automated tests.
4. Preview/start mismatch, double start, cancellation race, retry, process interruption and double draft/apply are tested. Successful batches are not charged again by retry.
5. Before draft apply, notes/chunks/links/config version remain unchanged. Existing completed-test and stale gates continue to pass their regression tests.
6. Owner browser flow works at 390px and desktop widths, keyboard focus is usable, reload resumes status, and an old source message opens correctly.
7. Build/typecheck and relevant test suites pass on a verified disposable database. Any unavailable provider check is reported as unverified, not passing.
8. Deployment is a separate coordinated gate after review and staging verification, with migration backup/rollback preparation.

## Explicit non-goals

No automatic publishing, automatic policy conflict resolution, embeddings/vector database, semantic dedupe guarantee, complete historical backfill guarantee, attachment processing, new AI pricing catalogue, or production OAuth reconfiguration without evidence.
