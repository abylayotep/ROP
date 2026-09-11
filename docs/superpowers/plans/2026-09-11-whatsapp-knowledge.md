# WhatsApp Knowledge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn selected stored WhatsApp history into source-backed, reviewed knowledge using existing drafts.

**Architecture:** Bounded asynchronous extraction stores run/batch/proposal records. Owners create ordinary drafts from reviewed proposals; existing testing and atomic apply remain the publication path. History import and Meta setup are independent bounded workstreams.

**Tech Stack:** TypeScript, Fastify, Drizzle/PostgreSQL, React/Vite, Zod, Vitest, existing OpenRouter client.

**Spec:** `docs/superpowers/specs/2026-09-11-whatsapp-knowledge-design.md`

## Current execution status

The baseline notes below describe the initial inspection, not the current implementation. T1–T9 code is implemented; final verification is recorded in [the release evidence](../../whatsapp-knowledge-verification.md). Individual original checkboxes remain conservative where their exact prescribed scenario was not independently demonstrated. Production rollout and private Meta OAuth validation are separate, uncompleted gates.

## Global Constraints

- Planning and specification use GPT-6 Astra; implementation subtasks use GPT-5.6 Sol.
- New repository artifacts are English; product strings and user communication are Russian.
- Each maintained Markdown file stays under 500 lines.
- Preserve existing user edits and coordinate shared files before editing.
- Database tests run only against a verified disposable test database; `withDb()` truncates tables.
- No production deployment, credential changes, or concurrent-worktree merge is part of a worker task.
- Reuse installed dependencies; do not introduce a queue service or new AI provider.

## Execution ownership

Each task is assigned to `gpt-5.6-sol` with this spec and its exact task body. Astra owns integration decisions and review. Do not silently switch models. Workers return changed paths, focused test evidence and unresolved dependencies; no deployment or broad cleanup.

Current adjacent work owns linked `client.ts`, `inbound.ts`, `normalize.ts`, `lid-directory.ts` and tests in `.claude/worktrees/obsidian-knowledge-base-f66bf4`; never edit/merge that worktree. The existing frontend prework is complete: Instagram cancellation during SDK loading and `getInstagramSetup` signal propagation; 82 tests and build passed. Preserve those changes.

T1 implementation prework is complete with a focused RED/GREEN regression and passing server typecheck. Its complete history-suite gate remains open: concurrent truncation of shared `rakurs_test` caused FK/deadlock failures. Use a dedicated disposable database per worker or exclusive serial coordination. New generation functionality remains unimplemented.

Safe parallel order: T1 and T2; then T3; T4 can follow T3 while T5 builds pure extraction. T6 requires T4+T5. T7 requires T6. T8 requires frozen T3 interfaces and integrates after T7. T9 can run independently after frontend-file ownership is released. T10 is last.

Shared files (`schema.ts`, contract, API registration, migration journal, `api/index.ts`) have one owner at a time. Generate migration numbers at execution, not from this document. Commits are optional handoff operations by the coordinator after review; never stage another worker's files.

## Contract sketch used by all tasks

The following are new shared types in `packages/contract/index.ts`; expand summaries with the fields in the spec without changing these names.

```ts
export type KbGenerationStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export interface KbGenerationSelection {
  conversationIds: string[];
  from: string;
  to: string;
}
export interface KbGenerationSource {
  conversationId: string;
  messageId: string;
  sentAt: string;
}
export interface KbGenerationProposal {
  id: string;
  revision: number;
  path: string;
  body: string;
  sources: KbGenerationSource[];
  warnings: ('dated' | 'conflict' | 'context_limited')[];
  status: 'pending' | 'rejected' | 'drafted' | 'applied';
  draftId: string | null;
  noteId: string | null;
}
```

## T1 — Imported history must not open live reply windows

**Worker:** Sol. **Dependencies:** none. **Files:** modify `server/src/lib/whatsapp/linked/history.ts`; test `server/test/linked-history.test.ts`; read `server/src/lib/whatsapp/history.ts`, `server/src/lib/whatsapp/store.ts`.

**Interface:** keep `applyHistoryChunk(db, numberId, chunk): Promise<void>` unchanged. Only historical `lastMessageAt` may advance.

- [ ] Verify the test database is disposable before the remaining full suite; coordinate exclusive test execution or allocate a dedicated disposable database.
- [x] Add a focused regression equivalent to this in the existing suite, which supplies `db`, `numberId`, and `chunk`:

```ts
it('does not open a live reply window for imported history', async () => {
  await applyHistoryChunk(db, numberId, chunk());
  const [stored] = await db.select().from(conversations);
  expect(stored?.lastInboundAt).toBeNull();
  expect(stored?.lastMessageAt).not.toBeNull();
});
```

- [x] Confirm the focused regression fails before the change and passes after it (Sol reported isolated 1/1 RED/GREEN).
- [x] Change the history call to `await advanceConversation(db, conversationId, line.sentAt, false);`.
- [ ] Confirm regression coverage also preserves an existing live `lastInboundAt` after newer history arrives; add coverage if absent.
- [ ] Run `npm --prefix server test -- test/linked-history.test.ts test/whatsapp-history.test.ts test/linked-inbound.test.ts`.

**Gate:** history changes no live window; live inbound behavior remains intact; no concurrent-worktree paths changed.

## T2 — History visibility and provider-state audit

**Worker:** Sol. **Dependencies:** none; coordinate before editing `IntegrationsScreen.tsx`. **Files:** read `server/src/api/conversations.ts`, `server/src/api/whatsapp-linked.ts`, `server/src/api/whatsapp-numbers.ts`, `rakurs/src/screens/DialogsScreen.tsx`, `rakurs/src/screens/IntegrationsScreen.tsx`; modify only those files where the audit proves a gap. Test `server/test/conversations.test.ts` (create if absent), `server/test/linked-history.test.ts`; create `rakurs/src/lib/history-status.ts` and `rakurs/src/lib/history-status.test.ts` only if state presentation needs extraction.

**Interface:** preserve existing conversation APIs; specify stable ordering `sentAt` then ID. Provider progress does not imply complete phone coverage.

- [ ] Compare persisted imported rows against list/thread queries using fixtures for both transports and repeated/out-of-order chunks.
- [ ] Record exact missing/incorrect behavior; implement only proven query or state-display gaps.
- [ ] Add assertions for zero-progress waiting, declined sharing, partial receiving, provider completion, disconnected state and equal message timestamps where modified.
- [ ] Run affected API/history tests and `npm --prefix rakurs run typecheck`.

**Gate:** stored history is reachable; zero progress is not mislabeled failure; no unsupported backfill promise. LID identity handling remains the adjacent worker's responsibility.

## T3 — Persistent generation schema and frozen contract

**Worker:** Sol. **Dependencies:** T1 baseline reviewed. **Files:** modify `server/src/db/schema.ts`, `packages/contract/index.ts`, `server/test/helpers/db.ts`; generate next files under `server/drizzle/` including metadata; create `server/src/lib/knowledge/generation-types.ts`, `server/src/lib/knowledge/generation-limits.ts`, `server/test/knowledge-generation-schema.test.ts`.

**Interface:** produce four tables named in spec and the shared types above. Internal manifest is `{ messageId, conversationId, contentHash, ordinal }[]`; do not store raw chat bodies. Export `GENERATION_LIMITS` with exactly the spec's numeric caps.

- [ ] Add migration tests for uniqueness of `(agentId, requestKey)`, active-run exclusion, batch ordinal and proposal fingerprint; assert agent deletion cascades.
- [ ] Implement schema, generated migration/journal and shared DTOs; extend disposable-test cleanup with new tables.
- [ ] Freeze `KbGenerationPreview`, `KbGenerationRun`, proposal pagination and request DTOs using the spec's endpoint fields; send exact names to T4/T6/T8 before parallel work.
- [ ] Run focused schema tests, `npm --prefix server run typecheck`, and `npm --prefix rakurs run typecheck`.

**Gate:** migration applies cleanly to empty and existing disposable databases; old draft tests still migrate; no raw transcript/key persistence.

## T4 — Owner-selected manifest and no-cost preview

**Worker:** Sol. **Dependencies:** T3. **Files:** create `server/src/lib/knowledge/generation-selection.ts`, `server/src/api/knowledge-generation.ts`, `server/test/knowledge-generation-selection.test.ts`, `server/test/knowledge-generation-api.test.ts`; modify `server/src/api/server.ts` for registration.

**Interfaces:** `previewSelection(db, agentId, selection)` returns persisted 15-minute preview plus counts/batches. `loadPreview(db, agentId, previewId)` validates expiry and frozen message hashes. Routes use `requireAgent(db, { role: 'owner' })` for mutations.

- [ ] Write fixtures for two agents, seller/customer/AI/system authors, overlong messages, empty captions, date boundaries and more than the allowed counts.
- [ ] Assert preview makes zero model calls and rejects foreign conversation IDs; mixed own/foreign selection must fail as a whole.
- [ ] Implement counted filtering, deterministic single-conversation batches, strict limits and manifest expiry. Store previews in `kb_generation_previews`; do not occupy the active-run index until start. Copy the frozen manifest into a run at admission.
- [ ] Implement only `/preview` here; expose selection helpers for T6. Test changed/deleted source hashes and 15-minute expiry.
- [ ] Run `npm --prefix server test -- test/knowledge-generation-selection.test.ts test/knowledge-generation-api.test.ts`.

**Gate:** no implicit sampling, no paid call, no cross-agent row leak; all exclusions are counted.

## T5 — Pure redaction, extraction and provider output cap

**Worker:** Sol. **Dependencies:** T3 contracts. **Files:** create `server/src/lib/knowledge/generation-redact.ts`, `server/src/lib/knowledge/generation-extract.ts`, `server/test/knowledge-generation-extract.test.ts`; modify `server/src/lib/ai/openrouter.ts`, `server/test/openrouter.test.ts`.

**Interfaces:** `redactGenerationText(text: string): string | null`; `extractGenerationBatch(deps, messages)` returns validated proposals plus completion usage. `deps` contains existing `ModelClient`, key, pinned model/temperature. Sources must come from supplied messages. `CompletionInput.maxTokens?: number` is backwards compatible.

- [ ] Test no seller evidence → no proposals; invented/cross-batch source ID → rejection; malformed JSON → safe error; injected chat instructions remain data; supported PII patterns are removed before fake-model input and refused in output.
- [ ] Implement bounded prompt and Zod validation for at most 20 proposals, using existing note length/path constraints. Preserve dates and qualifications. Build fingerprints from normalized text; exact duplicates collapse without overwriting existing notes.
- [ ] Pass `maxTokens: 2000`; test real client fetch serialization includes `max_tokens` only when supplied and old callers remain unchanged.
- [ ] Verify no automatic retry and completion usage survives parsing failure in the result/error path for accounting.
- [ ] Run `npm --prefix server test -- test/knowledge-generation-extract.test.ts test/openrouter.test.ts`.

**Gate:** injected fake model only; bounded input/output; validated seller citations and safe errors; no raw chats in logs.

## T6 — Asynchronous runs, progress, cancellation and bounded retry

**Worker:** Sol. **Dependencies:** T4+T5. **Files:** create `server/src/lib/knowledge/generation-run.ts`, `server/test/knowledge-generation-run.test.ts`; modify `server/src/api/knowledge-generation.ts`, `server/src/api/server.ts`, `server/src/index.ts`, generation API tests.

**Interfaces:** `startGenerationRun(db, agentId, userId, previewId, requestKey)` returns persisted summary; `executeGenerationRun(deps, runId)` performs sequential batches; `reconcileGenerationRuns(db)` marks interrupted work failed before listen. Existing shared turn-slot limiter is reused.

- [ ] Test concurrent same-key starts produce one run; same key/different selection gives 409; different keys while active give 409. Start answers 202 before completing the fake model.
- [ ] Implement database-guarded admission, one call per batch, 60-second slot-acquisition bound, usage accounting and sanitized failure codes.
- [ ] Add GET list/detail pagination and owner cancel/retry routes. Check cancellation before call admission and again before committing proposals; completed-call usage must survive cancellation.
- [ ] Test mid-call cancellation, process interruption reconciliation, two-attempt ceiling, malformed charged output, slot timeout and retry preserving successful batches.
- [ ] Run generation API/run tests and server typecheck.

**Gate:** reload can recover progress; no silent paid retry; no run stuck forever after restart; no second active run per agent.

## T7 — Review, draft conversion and durable provenance

**Worker:** Sol. **Dependencies:** T6. **Files:** create `server/src/lib/knowledge/generation-review.ts`, `server/test/knowledge-generation-review.test.ts`; modify `server/src/api/knowledge-generation.ts`, `server/src/lib/drafts/ops.ts`, `server/src/api/drafts.ts`, `server/src/api/knowledge.ts`, `packages/contract/index.ts` only if frozen DTO extension is required; test `server/test/draft-apply-api.test.ts`.

**Interfaces:** review updates use optimistic `revision`; draft conversion accepts explicit proposal IDs/revisions and optional owner-chosen update targets. `applyOps` gains an optional result/callback for note IDs without changing behavior for existing callers. Note detail gains structured source references.

- [ ] Test proposal edit/reject causes no live KB writes; foreign target note fails; stale revision fails; converting the same proposal selection twice yields one draft.
- [ ] Implement transactional selection locks, `baseOf` snapshots and ordinary manual-origin draft insertion. Limit conversion to 1–20 proposals. Existing draft test/apply requirements remain unchanged.
- [ ] Map applied ops to note IDs and persist provenance in the existing apply transaction; preserve single configuration-version bump and transaction rollback.
- [ ] Test failed/absent test-run blocks apply; stale target blocks apply; concurrent conversion/apply cannot duplicate notes; discarded draft can explicitly return proposals to review; deleted source displays unavailable.
- [ ] Run generation review, draft apply, draft ops and knowledge note-save tests.

**Gate:** no unreviewed knowledge reaches retrieval; existing draft tests remain meaningful; accepted notes retain source links outside indexed note bodies.

## T8 — Generation UI and source-message navigation

**Worker:** Sol. **Dependencies:** T3 frozen DTOs; final integration needs T7; existing frontend worker finished. **Files:** create `rakurs/src/components/knowledge/ChatGenerationPanel.tsx`, `rakurs/src/components/knowledge/GenerationReview.tsx`, `rakurs/src/components/knowledge/generation-state.ts`, `rakurs/src/components/knowledge/generation-state.test.ts`; modify `rakurs/src/screens/KnowledgeScreen.tsx`, `rakurs/src/components/knowledge/NotePanel.tsx`, `rakurs/src/screens/DialogsScreen.tsx`, `rakurs/src/api/index.ts`; modify `server/src/api/conversations.ts` and shared contract only for an authorized older-message anchor query.

**Interfaces:** consume T3 DTOs; selection → preview → async run → explicit selected proposals → existing DraftScreen. Use existing cancellable client and routing conventions. Source references include message ID, never model-provided navigation URLs.

- [ ] Add pure state tests for stale preview after selection change, completed-empty result, cancellation, failed partial run and preserved selections during polling.
- [ ] Build Russian selection/count/limits copy and no-default-selection review; disable owner actions for members while retaining server enforcement.
- [ ] Poll with bounded cadence only while active; abort requests on unmount/agent switch; recover run from URL and list after reload. Show actual cost and honest cancellation text.
- [ ] Add draft navigation, existing-note comparison/explicit target selection and source jump that fetches the cited older message. Test a source outside the initial conversation page and cross-agent source refusal.
- [ ] Run frontend tests/typecheck/build and relevant conversation API tests. Browser-check 390px/desktop, keyboard focus, errors, reload and old sources.

**Gate:** full owner flow works without automatic publication; UI does not imply unverified prices or complete imported history; prior cancellation/responsive fixes are preserved.

## T9 — Meta guidance and separate Instagram diagnosis

**Worker:** Sol. **Dependencies:** frontend file ownership released; independent of extraction. **Files:** modify `rakurs/src/screens/IntegrationsScreen.tsx`; read `server/src/api/capi.ts`, `server/src/lib/capi/client.ts`, `rakurs/src/components/knowledge/ImportPanel.tsx`, `rakurs/src/lib/embedded-signup.ts`, `server/src/lib/instagram/graph.ts`; create `docs/meta-setup-verification.md` under 500 lines; modify OAuth code only after evidence confirms a code defect.

- [ ] Check official current Meta documentation for the actual CAPI and Instagram flows; record links and verification date in the short document.
- [ ] Explain existing CAPI fields and explicit synthetic test-event action, distinguishing saved settings, provider response and Events Manager verification. Do not send an event just to inspect the page.
- [ ] Trace exact OAuth permissions and app/config evidence for `Invalid Scopes`, with token-free request details. Diagnose unsupported permissions versus wrong flow versus missing app setup using evidence.
- [ ] Fix only a proven local mismatch; if private app dashboard evidence is unavailable, record the exact missing setting and keep this acceptance check unresolved.
- [ ] Run frontend typecheck/build plus relevant existing Instagram/CAPI tests if code changes; manually check guidance links and layout.

**Gate:** useful setup instructions exist; no claim that OAuth is fixed without reproduction evidence; no credential/config mutation hidden in the task.

## T10 — Integration verification and release handoff

**Worker:** Sol executes tests; Astra reviews evidence. **Dependencies:** T1–T8; T9 reports its independent provider status. **Files:** update this plan's checkboxes and `docs/knowledge-base.md` only for implemented behavior; no unrelated cleanup.

- [ ] Review combined diff against every spec acceptance gate and concurrent-worker handoffs. Integrate adjacent history changes only through a separately coordinated completed handoff.
- [ ] Confirm dedicated disposable DB identity before running `npm --prefix server test`; never allow `TEST_DATABASE_URL` to resolve to customer data. Serialize DB suites because `withDb()` truncates global fixtures.
- [ ] Run `npm --prefix server run typecheck`, `npm --prefix server run build`, `npm --prefix rakurs test`, `npm --prefix rakurs run build`, plus the relevant server suites from T1–T7.
- [ ] Browser-run selection → generation → review/edit/reject → draft tests → apply → source navigation using fixtures and an injected model; verify no live WhatsApp sends or CAPI effects.
- [ ] Record pass/fail/unverified evidence, schema migration result, rollback approach and remaining provider-only checks. Deployment remains a distinct coordinated action.

**Gate:** all code acceptance conditions are demonstrated, no swallowed test failures, and external checks are labeled accurately.

## Coverage check

History/live safety: T1–T2. Tenant/owner isolation and limits: T3–T6. Source grounding/privacy: T4–T5. Progress/retry/cancel/cost: T6. Review/dedupe/publication/provenance: T7. Usability and source jumps: T8. Meta setup and actual OAuth evidence: T9. Integration and release readiness: T10.
