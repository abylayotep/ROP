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
