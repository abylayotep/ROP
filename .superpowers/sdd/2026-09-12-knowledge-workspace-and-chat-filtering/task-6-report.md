# Task 6 Report: Wide Knowledge Review Workspace

## Status

Completed. The Task 6 implementation is contained in the `feat: redesign the knowledge review workspace` commit.

## Scan and Diagnosis

- `KnowledgeScreen` stacks generation, WhatsApp history, the note vault, and imports in one long flow. It mixes page structure with extensive inline layout styles.
- `ChatGenerationPanel` renders the review inside one narrow card, truncates run history with `slice(0, 5)`, and does not paginate runs.
- Proposal selection in `GenerationReview` is local-only. It starts empty, can be lost when the component remounts, and does not use Task 4's revision-aware `selected` PATCH field.
- Detail pagination only advances proposals. Drafts, exclusions, and opt-in raw findings have independent server cursors that the UI does not consume.
- Polling has a merge helper for loaded proposal pages, but the polling call does not request preservation and the helper does not yet merge the other paginated collections.
- Existing controls do not consistently expose active, pressed, focus-visible, loading, empty, and retryable error states.
- The current flexible two-pane layout underuses wide screens and has no dedicated three-column review workspace.
- The repository already provides Golos Text, JetBrains Mono, neutral surface tokens, and one green accent. No new styling or component library is needed.
- Task 4 already provides member-readable run/style endpoints, owner-only mutations, persisted proposal selection, independent detail cursors, and complete run-to-draft links.

## TDD Evidence

- Initial workspace RED: all three new suites failed because `KnowledgeWorkspace`, `ProposalWorkspace`, and `CommunicationStyleCard` did not exist.
- Initial GREEN: the three new suites passed with 8 tests after the first implementation.
- Polling revision RED: an older first-page response replaced a newer persisted proposal revision; the focused state suite failed.
- Independent-cursor RED: polling restored exhausted draft/exclusion cursors and would refetch pages; the focused state suite failed.
- Complete-selection RED: draft assembly was disabled when persisted selections existed only on a later proposal page.
- Proposal mutation RED: revision-aware edit/reject and complete persisted-selection draft helpers were missing; two focused assertions failed.
- Every RED above was followed by a focused GREEN run before wider verification.

## Implementation

- Added page-level tabs for published knowledge, draft review, run review, and the Task 7 source-import integration seam. Explicit tabs survive refreshes, while `?generation=<runId>` without a tab opens draft review.
- Added the responsive three-column workspace: paginated run rail, grouped proposal review, and a sticky style/draft aside. It collapses to two columns at 1050px and stacks at 720px.
- Replaced local checkbox state with the server `selected` field. Checkbox changes are optimistic, revision-aware, and roll back on failure; bulk actions persist every changed visible proposal.
- Kept path/body edits and rejection revision-aware. Draft assembly auto-loads all remaining proposal pages and submits exactly the complete persisted pending selection.
- Added independent proposal, draft, exclusion, and raw-finding pagination. Polling merges current loaded pages and refuses to overwrite a newer proposal revision.
- Added source counts and links, warning states, exclusion reasons, collapsed raw findings, run metrics/errors, and every loaded run draft shortcut.
- Added communication-style read/save with server-provided previews and member read-only behavior.
- Moved layout and interaction styling into a scoped stylesheet using the existing Golos/JetBrains fonts, neutral tokens, and green accent. Added skeleton, empty, error, hover, pressed, and focus-visible states.
- Left `HistoryImportPanel` and `ImportPanel` unchanged and only mounted them in the sources-tab seam for Task 7.

## Verification

- Focused Task 6 and generation regression suite passed: 6 files, 29 tests.
- Full Rakurs frontend suite passed: 25 files, 135 tests.
- `npm --prefix rakurs run typecheck` passed.
- `npm --prefix rakurs run build` passed.
- `git diff --check` passed.

## Concerns

- The local browser smoke check reached the authentication gate. No account credentials were used, so responsive verification is covered by the compiled CSS breakpoints and component tests rather than an authenticated screenshot.
- Task 7 still needs to replace the temporary sources-tab seam with single-expanded source cards.

## Fix Round 1

### Diagnosis

- Polling scheduled a retry only after failures, so the first successful response stopped all further updates.
- A running response with an early `null` cursor could be merged as if pagination were exhausted and hide pages produced when the run completed.
- Selection limits and bulk clearing were calculated from rendered rows instead of the complete persisted run selection.
- Independent proposal mutations could commit out of revision order, and revision-keyed cards remounted away unsaved field edits.
- Proposal fields were always expanded, tab semantics lacked keyboard behavior, and pagination errors shared a generic AI-settings error.

### Corrections

- Polling now schedules the next tick after success or failure, stops on terminal state/disposal/run switch, and refreshes the matching run rail summary.
- Active detail refreshes rebase collection first pages and cursors while preserving a newer local proposal revision. Only a stable terminal run keeps loaded later pages.
- Selection loads the complete proposal collection before mutation, enforces a run-wide persisted limit of 20, fills only remaining visible slots, and clears selected proposals across every kind and page. Draft creation rejects an oversized persisted selection before calling the API.
- Per-proposal mutations are serialized, older reducer responses are ignored, and optimistic selection rollback is isolated from newer committed revisions.
- Proposal cards use stable IDs, preserve dirty fields across server revisions, and expose one explicit editor at a time. Read-only/default rows remain compact.
- Both tab systems now expose linked tab/tab-panel IDs and wrapped ArrowLeft/ArrowRight/Home/End navigation.
- Run/detail and collection pagination now show scoped loading, disabled, failure, and retry states. Reloading the selected run is allowed, and generic failures no longer imply AI configuration is the cause.
- Raw audit rows now expose warnings and available source evidence. Mobile controls use practical 44px targets and readable minimum supporting text.

### Verification

- Focused polling/state/workspace suite: 4 files, 35 tests passed.
- Full Rakurs frontend suite: 26 files, 150 tests passed.
- `npm --prefix rakurs run typecheck` passed.
- `npm --prefix rakurs run build` passed.
- `git diff --check` passed.

### Remaining Concern

- Authenticated visual smoke testing remains unavailable in this worktree; responsive behavior is verified through component markup, compiled CSS breakpoints, and the production build.
