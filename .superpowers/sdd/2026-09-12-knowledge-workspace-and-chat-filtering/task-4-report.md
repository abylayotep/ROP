# Task 4 Report: Knowledge Review Workspace APIs

## Status

Completed in commit `91f1bd0` (`feat: add knowledge review workspace APIs`).

## Implementation

- Added revision-safe persisted proposal selection. Rejecting a proposal clears its selection.
- Made draft creation compare the request with the complete persisted pending selection, lock the run and proposals, verify revisions and tenant ownership, create the draft relation transactionally, and clear the consumed selection.
- Kept generation review non-publishing: draft creation writes neither `kb_notes` nor `agent_rules`.
- Added paginated enriched run summaries with classification counts, exclusion counts, provider usage/cost, run and batch errors, and every related draft.
- Added run detail exclusions and opt-in immutable raw findings through `includeRawFindings=true`.
- Preserved historical draft visibility by reading the durable relation and the pre-relation proposal links without backfilling or rewriting data.
- Normalized terminal historical batches with nullable classification to `uncertain` / `Более ранний запуск` only in API responses.
- Added tenant-scoped communication-style GET/PATCH routes. Members can read, owners can update, invalid presets are rejected, previews are deterministic Russian strings, and actual style changes bump `configVersion` transactionally.
- Completed typed client methods and tightened proposal response fields `kind`, `confidence`, and `selected` to required.

## TDD Evidence

- Initial focused RED run: 9 feature assertions failed on missing selection persistence, run metadata, exclusions/raw audit data, draft relation persistence, and style routes.
- Historical draft fallback RED: detail omitted a pre-relation draft.
- Category relation RED: the legacy category helper created drafts without durable run links.
- GREEN: all focused and expanded regression suites passed after the implementation.

## Verification

- `npm --prefix server test -- knowledge-generation-api.test.ts knowledge-generation-review.test.ts agent-style-api.test.ts rules-api.test.ts knowledge-api.test.ts` — 5 files, 49 tests passed.
- Expanded regression run including `knowledge-generation-workspace-schema.test.ts` and `draft-apply-api.test.ts` — 7 files, 67 tests passed.
- `npm --prefix server run typecheck` — passed.
- `npm --prefix rakurs run typecheck` — passed.
- `git diff --check` — passed before commit.

## Concerns

- The existing review UI still keeps checkbox state locally. Task 6 must switch it to the new persisted selection API before the workspace is considered end-to-end complete.
- No Task 4 server/API concerns remain.

## Fix Round 1

- Serialized proposal edits and selection changes with draft creation by locking the owning generation run before checking proposal revision or state. A deterministic lock-order test proves a concurrent selection update cannot enter a draft's persisted selection scan.
- Limited historical nullable classification normalization to batches whose own status is `done`; failed and cancelled nullable batches remain operational failures, not review exclusions.
- Added migration `0030_backfill_generation_draft_links` for normal legacy proposal links. Migration `0029` now preserves raw proposal draft relations before discarding or deleting legacy raw proposals, while the runtime apply and discard paths repair missing relations before proposal cleanup.
- Bounded proposals, drafts, exclusions, and opt-in raw findings at 20 rows with independent cursors exposed by the contract and typed client.
- Replaced per-run history summary lookups with four bounded batch queries across the current run page, including a partitioned draft window.
- Removed the unused `createGenerationCategoryDrafts` production entry point so every generation draft must pass the persisted checked-set invariant.

### Fix Verification

- RED: 9 focused assertions failed before implementation, covering lock ordering, failed/cancelled classification, four collection boundaries, both migrations, and runtime relation repair.
- GREEN: `knowledge-generation-api`, `knowledge-generation-review`, `knowledge-generation-run`, both generation schema suites, both generation migration suites, `draft-apply-api`, `draft-run-api`, and `agent-style-api` passed: 10 files, 90 tests.
- `npm --prefix server run typecheck` and `npm --prefix rakurs run typecheck` passed.
- `git diff --check` passed.

### Fix Concerns

- The detail response keeps the existing collection arrays for Task 6 compatibility and adds an independent `nextCursor` field beside each collection; the typed client accepts all four cursors without requiring UI changes in this task.

## Fix Round 2

- Restored migration `0029_knowledge_generation_raw_findings` byte-for-byte to commit `ffd8c1f`; its only responsibility is creating the raw-findings table, constraints, and indexes.
- Kept `0030_backfill_generation_draft_links` additive and added `0031_migrate_remaining_legacy_raw_proposals`. The new migration preserves raw proposal draft relations, discards linked open drafts, copies immutable findings with conflict-safe inserts, and only then deletes legacy raw proposals.
- Reworked the migration regression to exercise the exact upgrade path: migrations through `0028`, original `0029`, current `0030`, then retry-safe `0031`. It verifies preserved links, discarded unsafe drafts, migrated/deleted raw proposals, and refusal to apply the discarded draft without writing a note.
- Replaced the concurrency test's broad query-text match with a dedicated PostgreSQL connection tagged by `application_name`; `pg_blocking_pids` now proves that the actual proposal PATCH backend is waiting.
- Strengthened pagination coverage with distinct collection sizes and contents. A proposal-only cursor proves the other three collections stay on page one, and a mixed `20/10/3/20` request proves each collection advances independently.

### Fix Round 2 Verification

- Migration RED: with original `0029` and blank `0031`, four proposals remained and the unsafe draft stayed open.
- Migration GREEN: focused migration, concurrency, and pagination suite passed, 3 files and 18 tests.
- Concurrency mutation check: removing the owning-run lock made the dedicated-backend assertion fail with `updateWaitsForRun=false`; restoring the lock made the test pass.
- Full API, review, run, migration, schema, draft, and style regression suite passed: 10 files and 90 tests.
- `npm --prefix server run typecheck`, `npm --prefix rakurs run typecheck`, and `git diff --check` passed.
