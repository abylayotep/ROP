# WhatsApp Knowledge Release QA

Date: 2026-09-11. Scope: WhatsApp connection/history, knowledge generation and review,
source navigation, integrations, responsive layout, and adjacent navigation.

## Pre-release checks

- The production source matched `origin/main`; the adjacent worktree's linked-identity
  changes are preserved in the release. Production uses a direct VPS/Compose rollout,
  not a PR-triggered deployment pipeline.
- A PostgreSQL custom-format backup, application archive, frontend archive, and old API
  image were retained on the VPS. The backup catalogue is readable by `pg_restore`.
- Restored the backup into isolated `rakurs_release_20260911` on the same host. Migration
  `0021` succeeded: the journal advanced from 21 to 22 entries and all four generation
  tables exist. No application process was started against the restored copy.
- Production has all seven coexistence columns omitted by the historical duplicate
  `0011` filename. The old migration-journal inconsistency remains a fresh-install
  maintenance issue, not a blocker for this already-provisioned database.
- The real public webhook verification returned HTTP 200 and the exact challenge.
  The verify token was neither changed nor recorded in this report.

## Browser evidence before cutover

- The real signed-in production account opens orders, dialogs, customers, integrations,
  and statistics. No browser console errors were captured on the inspected pages.
- Production has zero conversations and zero messages, matching the empty dialogs UI.
  The linked number is enabled with stored state `open`, progress zero, and 175 stored
  authentication keys. The current container has no `linked:` history log records.
  A stored `open` state is not proof of current socket connectivity.
- An isolated local fixture uses fake model, Meta, WhatsApp, and page-fetch clients.
  Selected history previews correctly; rerunning an already-applied fact produces no
  duplicate proposal or published note. The reported fixture cost is synthetic.
- A note's source link opens its exact WhatsApp conversation/message. Both customer and
  phone-authored messages render, along with the AI switch and responsible-person field.
- Knowledge and an open dialogue have document width 381 px at a 390 px viewport.
  Inline screenshots were inspected. The temporary viewport override was reset.
- The graph explains the single-note state. Unsaved note text survives switching to the
  graph and back. Testing the discard confirmation blocked the in-app browser control;
  dismissing that native prompt was handed to the user, not counted as verified.
- Two React Router future-version warnings appeared in development; no JavaScript error
  was captured. They are not evidence of a production failure.

## Fixes found during release QA

- `1a58c5c`: full-history configuration used a custom OS name that pinned Baileys 6.7.24
  treated as `WEB_BROWSER`. It now uses `Browsers.macOS` with the existing product label.
  A new isolated regression failed before the fix and passed afterwards; typecheck passed.
  This does not erase authentication or guarantee retrospective delivery from WhatsApp.
- Updated the rollout instructions to migrate before starting the new API. Startup
  generation reconciliation requires the new tables. Hashed frontend assets are retained
  and the entry HTML is published last, avoiding broken already-open sessions.

## External limitations

Instagram permission acceptance still requires the private Meta application configuration.
CAPI acceptance requires a configured dataset/token and Events Manager verification.
No customer message, paid model request, conversion event, disconnect, or production data deletion
was performed during browser QA. No claim is made that all phone history has arrived.

## Release status

Deployed on 2026-09-11 at approximately 18:59 UTC (23:59 Asia/Almaty).

- Release code: `eac49e2` plus `1a58c5c`. Astra's final narrow release review found no blocker.
- Final valid server run: 95 files, 1,306 tests passed, exit 0, 212.38 seconds.
  An earlier sandbox-denied run failed with local database `EPERM`; it was stopped before
  the single properly authorized run began and is excluded from release evidence.
- Frontend: 91 tests in 12 files passed; frontend/server production builds and server
  typecheck passed. No test suite used the production database.
- Production migration journal now has 22 entries. Migration preceded API replacement.
  The first immediate health probe encountered the container's connection reset during
  startup; the subsequent readiness probe and public health checks succeeded.
- Running image matches the prepared release:
  `sha256:bea2b3a01c5ac18e98f075d50fc492028fd5babfa969c54ffb7cb04593135e46`.
  The container is running with zero restarts and zero error-level log records observed.
- Published entry HTML SHA-256 matches the local build:
  `addbd5f89185644fa10076bad004cda29e9bde27307846785827e805038fcacd`.
  Assets were transferred first, old hashed assets retained, and HTML replaced atomically.
- Signed-in production browser reload shows the new generation panel and correct empty
  history state. No browser warnings/errors were captured after the inspected cutover.
- The linked session remains stored and enabled. History progress and stored messages
  remain zero; retrospective history delivery is NOT verified or claimed as fixed.
- The isolated rehearsal database was removed after validation. Protected PostgreSQL,
  application, frontend backups and the previous image remain available on the VPS.

## 2026-09-12 knowledge workspace release

Scope: the redesigned knowledge workspace, two-week WhatsApp learning flow, customer-chat
filtering, communication style, proposal review, independent knowledge/script drafts, and
the production logging hardening discovered during release QA.

### Verification before deployment

- Release commits are `6489031`, `e73a4f9`, and `309074f`. The final release SHA recorded
  on the host is `309074f83a9389c01345eaa333bf5ed9b30cc974`.
- Migration `0033_generation_draft_request_key.sql` was rehearsed against a restored
  production backup. The rehearsal advanced the journal from 33 to 34 entries and was
  removed afterwards. The production journal is also at 34 entries.
- Five focused server suites passed 41/41 tests against a fresh database. The frontend
  passed 186/186 tests. Server and frontend typechecks/builds, the Drizzle consistency
  check, and the clean migration-diff check passed.
- The unfiltered full server command is not release evidence: it remained running after
  the test runner banner without producing test results. Focused database suites and the
  build/typecheck gates are the authoritative evidence for this release.
- The libsignal regression test failed before the patch existed and passed 2/2 after it
  was added. The production image build ran the patch during `postinstall`.

### Real two-week run

- Run `cf4eb227-6f64-431f-8f18-897bbb4e0e0d` covered the inclusive two-week window shown
  in the UI. It processed 83/83 batches and produced 15 consolidated proposals.
- Selection included 81 conversations and 2,910 messages. Of those, 1,972 were eligible;
  659 empty, 1 missing seller, 16 sensitive, and 262 unsupported messages were skipped.
  Classification produced 41 customer chats, 33 uncertain chats, and 9 unusable provider
  responses. Non-customer or uncertain conversations were not silently treated as facts.
- The run used 169,247 prompt tokens and 26,785 completion tokens (196,032 total). The
  recorded estimated cost is `$0.04145805`; the provider remains the billing authority.
- Manual review retained eight proposals: four knowledge items and four sales-script
  items. Seven unrelated, duplicate, or unsuitable proposals remained unselected.
- The first mixed draft was discarded and repaired without another paid model run. The
  open replacement drafts are `0bd9538d-b0c2-40ea-ad08-904f5d438a31` (knowledge, four
  operations) and `25921d0a-7fe4-48fa-b4c7-b4cfc604c2a5` (script, four operations).
- Exact request replay is idempotent through a canonical request key. Partial or union
  replay of already-drafted proposals returns a conflict instead of creating duplicates.

### Production acceptance

- The signed-in desktop browser shows the redesigned tabs, persistent run history,
  two-week preparation card, proposal checkboxes, audit reasons, source links, and the
  saved friendly communication style. Earlier responsive QA also covered the mobile
  workspace layout.
- The latest run displays both open replacement drafts and the discarded mixed draft for
  audit. The knowledge draft contains four `База знаний/` paths and no `Скрипт/` paths;
  the script draft contains four `Скрипт/` paths.
- Browser console inspection after the final deployment returned no entries. Private and
  public `/api/health` checks returned `{"ok":true}`. The API container is running with
  zero restarts on image
  `sha256:4165a40b23234c37fdff5c4a6257e2d621505714440814a4ea7ffa269bee6511`.
- Database inspection after the restart found zero published knowledge notes and zero
  agent rules for the target agent. Both replacement drafts remain open; all eight curated
  proposals are drafted and none are selected. Publication still requires explicit review,
  testing, and apply actions.
- Release QA found that an upstream session library bypassed the configured silent logger.
  The final image removes all four sensitive logging calls while retaining an exact,
  idempotent, fail-closed build patch. No secret or session-key material is recorded here.

### Recovery

- Pre-release and post-repair database dumps plus the frontend archive are stored under
  `/opt/rakurs-backups/20260912-split-drafts-e73a4f9`. The earlier full release backup is
  under `/opt/rakurs-backups/20260912-knowledge-workspace-6489031`.
- Rollback images are tagged `rakurs-api:before-split-drafts-e73a4f9` and
  `rakurs-api:before-safe-logs-309074f`. The latter is the immediately previous API image.
- Instagram permission acceptance and Meta CAPI event acceptance remain external Meta
  configuration checks; this release does not claim that Meta has approved either one.
