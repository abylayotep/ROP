# CRM and Kaspi production release QA

Date: 2026-09-12. Production: https://rop.tasbaqa.ru.

## Release and validation

- Merged the divergent remote main into an isolated release checkout, retaining the
  newer tenant-scoped WhatsApp LID implementation and already deployed history changes.
- Initial merged release: `793cb34`. Production QA fixes: `696c088` and `9a537a0`.
- Full merged server suite: 109 files, 1,420 tests passed. Frontend: 22 files,
  121 tests passed. Both production builds passed.
- The two parser corrections were reproduced with failing regression tests, then
  verified with nine analysis tests and 20 worker/live tests, plus server builds.
- A synthetic OpenRouter check confirmed model connectivity. A synthetic CRM response
  reproduced malformed optional evidence. No real conversation was used for that
  diagnostic request. A separate SQL check used a fake model and rolled back all writes.

## Rollout

- Retained PostgreSQL, application and frontend backups at
  `/opt/rakurs-backups/20260912-crm-kaspi/` and image
  `rakurs-api:before-crm-kaspi-20260912`.
- Restored the backup into a separate rehearsal database. The migration journal
  advanced from 23 to 28 entries, preserving all 79 conversations.
- Applied production migrations before replacing the API. Started the private Kaspi
  sidecar with its own stable secret and persistent device state.
- Published hashed frontend assets before atomically replacing the entry HTML.
  Entry SHA-256: `6f33c6885c1bf3ee2921563e09b096b80ae1304316cad7eb016b03e914df04bc`.
- Public and private API health checks returned success. The sidecar returned the
  expected unauthenticated 401 from its session endpoint. No ports were exposed for
  PostgreSQL or Kaspi; API remains bound to loopback.

## Browser and operational checks

- Signed-in production opens the funnel, verified orders, a real dialog and integrations.
  The inspected browser pages had no captured console errors or warnings.
- Final verification found all 80 conversations analyzed with status `ready`, no failed
  analyses and no captured API/POS errors. The count includes a conversation received
  after the 79-conversation backup. Historical analysis never authorized customer messages.
- Final API image: `sha256:eb7211339be38f3cd085836127250486b79366232aebd12af1921b7231e9539d`.
  API and POS containers remained running with zero restarts. The rehearsal database was
  removed after verification; all rollback backups remain protected on the host.
- Kaspi cashier login is not connected. The owner must complete phone/SMS login in
  integrations before invoice or QR checkout can work. No real invoice or paid test
  transaction was created during release QA.
