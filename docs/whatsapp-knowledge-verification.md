# WhatsApp Knowledge: Verification and Release

Date: 2026-09-11. Planning and review: GPT-6 Astra. Implementation: GPT-5.6 Sol.

## Implemented workflow

The knowledge screen lets owners select stored conversations and a local-date interval, preview eligible text without an AI request, and start bounded asynchronous extraction. Suggestions require explicit review and selection. They become ordinary drafts, with the existing test-run and stale-version checks required before publication.

Members can read runs, proposals, and conversation sources but cannot start or modify generation. Applied notes retain authorized links to their source messages. Historical WhatsApp imports do not advance the live reply window. Linked account-ID resolution is scoped to the connected number; history learns known phone mappings before processing outgoing messages.

Extraction handles stored text only. Each run is limited to 200 conversations, 5,000 eligible messages, 200,000 characters, and 20 calls on its first attempt. Each batch is limited to 100 messages and 10,000 characters, with 2,000 output tokens. Explicit retries are limited to two attempts per batch. Reported cost can be incomplete after a provider timeout or missing usage response.

## Local evidence

- Final frontend integration: 91 tests passed across 12 files; production build passed. Server typecheck and production build passed independently.
- Astra reviewed source isolation, extraction limits, historical-window preservation, linked number scoping, and draft publication. Three review findings in proposal restore/fingerprints/discard revisions were fixed and re-reviewed cleanly.
- Browser fixture used `rakurs_generation_integration_test` only, with fake model, WhatsApp, Meta, and page-fetch clients. No real AI, WhatsApp send, or conversion event was used.
- Browser: select conversation → preview → completed run → reject → restore → choose existing-note target → create draft → required test run → apply → updated note → exact source-message focus passed.
- Browser: editing a proposal and existing-note comparison passed. Clearing the start date kept the page usable and disabled preview.
- Browser at 390 px: knowledge, draft, integrations, and an open dialogue have no horizontal document overflow. The open dialogue measured 381 px document width inside a 390 px viewport after the composer fix.
- A fixture restart initially cleared its disposable data; the preserve mode now bypasses the truncating test helper. Production data was never involved.
- Astra's final narrow review confirmed member read access, immutable drafted/applied controls, cost/retry warnings, page-2 proposal refresh, and preservation of concurrent edits during page loading. Regressions cover the page-loading race.
- Final server suite: `cd server && TEST_DATABASE_URL=postgres://rakurs:rakurs@localhost:55432/rakurs_generation_t3_test npm test -- --no-file-parallelism` exited 0: 94 files, 1,305 tests passed in 243.51 seconds. Focused generation/review/draft coverage also passed (27 tests).
- Earlier attempts are not release gates: two test processes accidentally overlapped on the disposable database and conflicted in `withDb()` truncation. A subsequent serial run passed 1,304 of 1,305 tests; the sole stale diagnostic-text assertion was updated. The final serial run above passed every test after these corrections.

## Remaining external checks

- Instagram `Invalid Scopes` cannot be declared fixed without the private Meta app products, permission access, app mode, and actual OAuth response. Local cancellation/error handling is implemented separately.
- CAPI help describes the existing dataset/token/Test Events workflow. Provider acceptance and appearance in Events Manager require account-specific verification; no credential or dashboard setting was changed.
- Webhook URL presence does not prove successful Meta verification. A request without verification parameters returning 403 is not a broken callback.
- See [Meta setup verification](meta-setup-verification.md) for official links and evidence limitations.

## Deployment and rollback

The implementation was committed as `eac49e2`, followed by the linked desktop-profile correction `1a58c5c`. See [release QA](whatsapp-knowledge-release-qa.md) for current deployment evidence and external limitations. Before rollout, back up PostgreSQL and rehearse generated migration `0021_ordinary_solo.sql` on an isolated restored database. Apply it before starting the new API, then publish the frontend after the API health check succeeds.

The migration adds generation tables and indexes. Prefer rolling application code back while retaining these additive tables; do not drop them or remove migration-journal records as an automatic rollback. Retain reviewed proposals and provenance. A database restore is a separate, explicitly approved recovery operation.

Existing historical messages omitted before the linked identity fix are not reconstructed automatically. Provider-reported history completion does not guarantee a complete phone archive, and in-memory identity mappings must be learned again after restart.
