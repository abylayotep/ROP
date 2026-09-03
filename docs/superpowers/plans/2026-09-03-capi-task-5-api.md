### Task 5: Settings, the log, and resending

**Files:**
- Create: `server/src/api/capi.ts`
- Modify: `server/src/api/server.ts`
- Modify: `packages/contract/index.ts`
- Create: `server/test/capi-api.test.ts`

**Interfaces:**
- Produces `registerCapiRoutes(app, db, env, guard, capi)` with:
  - `GET /api/agents/:agentId/capi` → `CapiSettings`, any member — never the token, only `tokenSet`
  - `PUT /api/agents/:agentId/capi` → `CapiSettings`, owner — writes the dataset id and token, and VERIFIES them against Meta before saving
  - `DELETE /api/agents/:agentId/capi` → `{ ok: true }`, owner
  - `GET /api/agents/:agentId/capi/events` → `CapiEvent[]`, any member — the last fifty, newest first
  - `POST /api/agents/:agentId/capi/events/:eventId/resend` → `CapiEvent`, any member
- Contract: `CapiSettings` (`datasetId`, `testEventCode`, `enabled`, `tokenSet`, `verifiedAt`, `error`), `CapiEvent` (`id`, `kind`, `status`, `attempts`, `error`, `sentAt`, `createdAt`, `value`, `currency`, `contactName`, `contactPhone`).

**Context.** What the cabinet needs to configure this and to see whether it worked.

**Verify before saving.** pleep validates the pair against Meta when it is saved, and it is right to: a dataset id with a typo fails silently for weeks otherwise, and the owner discovers it when they wonder why their ads got worse. Send a `test_event_code`-marked event on save; a refusal is a 502 carrying Meta's own reason, and nothing is stored. Say in the response what was verified.

**Resending.** Sets a row back to `pending` and clears its attempts, whatever it was — `failed`, `skipped`, or even `sent`. The `eventId` does not change, so Meta counts it once regardless; that is what makes the button safe to press. A `sent` row re-sent is how an owner recovers from Meta losing something, and the uniqueness of the id is why it costs nothing.

**The log is for reading a failure.** Show Meta's own words in full. «Invalid access token» and «ctwa_clid expired» are both actionable, and only by the owner.

- [ ] **Step 1: Write the failing test**
- [ ] **Step 2: Run it and watch it fail**
- [ ] **Step 3: Write the routes**
- [ ] **Step 4: Run everything and commit**

Cover in the test: the token is never returned; saving verifies and refuses a bad pair without storing; the log is scoped to the agent and another agent's event answers 404; a resend re-queues and keeps the `eventId`; a member may resend but not configure.

```bash
git add server packages
git commit -m "Configure the dataset, read the log, resend one event"
```
