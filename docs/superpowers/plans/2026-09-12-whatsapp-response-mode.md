# WhatsApp Response Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restrict all automated WhatsApp and CRM behavior to off, one selected contact, or every eligible contact.

**Architecture:** Store an explicit response mode and nullable test contact on the agent. A central policy returns a reasoned allow/deny decision and is checked before model/CRM work and again before side effects.

**Tech Stack:** TypeScript, Fastify, Drizzle ORM, PostgreSQL, React, Vitest

**Spec:** `docs/superpowers/specs/2026-09-12-whatsapp-test-mode-and-coaching-design.md`

## Global Constraints

- Existing agents preserve behavior: disabled becomes `off`, enabled becomes `live`; new agents default to `off`.
- Test mode with no valid contact denies automation for everybody.
- Denied inbound messages remain stored and visible.
- Manual operator messages are unaffected.
- Keep all maintained Markdown files below 500 lines.
- Preserve unrelated working-tree changes.

---

### Task 1: Persist and expose response mode

**Files:**
- Modify: `server/src/db/schema.ts`
- Create: next generated file under `server/drizzle/`
- Modify: `server/drizzle/meta/_journal.json`
- Create: next generated snapshot under `server/drizzle/meta/`
- Modify: `packages/contract/index.ts`
- Test: `server/test/ai-schema.test.ts`

**Interfaces:**
- Produces: `AgentResponseMode = 'off' | 'test' | 'live'`
- Produces: `AiTestContact = { id: string; name: string | null; phone: string }`
- Extends: `AiSettings` with `responseMode` and `testContact`

- [ ] **Step 1: Add a failing schema/contract test**

Assert that a new agent defaults to `off`, all three values round-trip, and `testContactId` becomes null when its contact is deleted.

```ts
expect(created.responseMode).toBe('off');
expect(settings.testContact).toEqual({ id: contact.id, name: 'Tester', phone: '77001234567' });
```

- [ ] **Step 2: Run the focused test and confirm failure**

Run: `cd server && npx vitest run test/ai-schema.test.ts`

- [ ] **Step 3: Add schema and contract fields**

Use a checked text column and nullable foreign key:

```ts
export type AgentResponseMode = 'off' | 'test' | 'live';

responseMode: text('response_mode').notNull().default('off'),
testContactId: uuid('test_contact_id').references(() => contacts.id, { onDelete: 'set null' }),
```

Generate the migration through the repository's existing Drizzle script. Backfill existing rows from `ai_enabled`, then add the check constraint. Do not hand-edit existing migrations.

- [ ] **Step 4: Run schema tests and typecheck**

Run: `cd server && npx vitest run test/ai-schema.test.ts && npm run typecheck`

- [ ] **Step 5: Commit only Task 1 files**

```bash
git commit -m "feat: add agent response modes"
```

### Task 2: Centralize the automation decision

**Files:**
- Create: `server/src/lib/automation/policy.ts`
- Test: `server/test/automation-policy.test.ts`

**Interfaces:**
- Produces: `AutomationPurpose = 'reply' | 'crm' | 'checkout'`
- Produces: `AutomationSnapshot`
- Produces: `AutomationDecision = { allowed: boolean; reason: string }`
- Produces: `loadAutomationSnapshot(db, input)` and `decideAutomation(snapshot, purpose)`

- [ ] **Step 1: Write table-driven failing policy tests**

Cover off, live, matching test contact, nonmatching test contact, missing test contact, disabled conversation, disabled WhatsApp number, and foreign/deleted contact.

```ts
expect(decideAutomation({ ...base, responseMode: 'test', testContactId: 'a', contactId: 'b' }, 'reply'))
  .toEqual({ allowed: false, reason: 'test_contact_mismatch' });
```

- [ ] **Step 2: Run the test and confirm failure**

Run: `cd server && npx vitest run test/automation-policy.test.ts`

- [ ] **Step 3: Implement the pure decision and snapshot loader**

Keep mode logic pure. The loader must scope agent, conversation, contact, and number in one tenant-safe query.

```ts
export function decideAutomation(snapshot: AutomationSnapshot, purpose: AutomationPurpose): AutomationDecision {
  if (snapshot.responseMode === 'off') return { allowed: false, reason: 'agent_off' };
  if (snapshot.responseMode === 'test' && !snapshot.testContactId) return { allowed: false, reason: 'test_contact_missing' };
  if (snapshot.responseMode === 'test' && snapshot.contactId !== snapshot.testContactId) return { allowed: false, reason: 'test_contact_mismatch' };
  if (!snapshot.conversationAiEnabled) return { allowed: false, reason: 'conversation_disabled' };
  if (purpose === 'reply' && !snapshot.numberEnabled) return { allowed: false, reason: 'number_disabled' };
  return { allowed: true, reason: 'allowed' };
}
```

- [ ] **Step 4: Run focused tests**

Run: `cd server && npx vitest run test/automation-policy.test.ts`

- [ ] **Step 5: Commit only Task 2 files**

```bash
git commit -m "feat: centralize automation policy"
```

### Task 3: Enforce policy across AI, WhatsApp, and CRM

**Files:**
- Modify: `server/src/lib/whatsapp/store.ts`
- Modify: `server/src/lib/ai/turn.ts`
- Modify: `server/src/lib/crm/live.ts`
- Modify: `server/src/lib/crm/worker.ts`
- Test: `server/test/ai-inbound.test.ts`
- Test: `server/test/ai-turn.test.ts`
- Test: `server/test/linked-inbound.test.ts`
- Test: `server/test/crm-live.test.ts`
- Test: `server/test/crm-worker.test.ts`

**Interfaces:**
- Consumes: `loadAutomationSnapshot` and `decideAutomation`
- Preserves: `runTurns`, `runTurn`, `createLiveCrmHandler`, and `analyzeConversation` public signatures

- [ ] **Step 1: Add failing denial and race tests**

Prove that denied Cloud and Linked messages are stored but cause zero model calls, CRM changes, checkout creation, handoff, or outbound sends. Add a deferred model test that changes mode before resolution and expects no side effect.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `cd server && npx vitest run test/ai-inbound.test.ts test/ai-turn.test.ts test/linked-inbound.test.ts test/crm-live.test.ts test/crm-worker.test.ts`

- [ ] **Step 3: Gate before expensive work**

Load and decide at the entry to `runTurns`, `runTurn`, live CRM, and queued CRM processing. Return the existing skipped/no-reply shape so callers remain compatible.

- [ ] **Step 4: Gate again before every effect**

Reload current state immediately before outbound send and before committing stage, field, lead, checkout, or handoff changes. Never reuse the pre-model snapshot for this check.

- [ ] **Step 5: Run focused tests**

Run the command from Step 2 and require all tests to pass.

- [ ] **Step 6: Commit only Task 3 files**

```bash
git commit -m "feat: enforce response mode across automation"
```

### Task 4: Add owner controls and test-contact selection

**Files:**
- Modify: `server/src/api/ai.ts`
- Modify: `packages/contract/index.ts`
- Modify: `rakurs/src/api/index.ts`
- Modify: `rakurs/src/screens/AgentScreen.tsx`
- Create: `rakurs/src/screens/agent-response-mode.ts`
- Test: `server/test/ai-api.test.ts`
- Create: `rakurs/src/screens/agent-response-mode.test.ts`

**Interfaces:**
- Extends: `PATCH /api/agents/:agentId/ai` with `responseMode` and `testContactId`
- Produces: atomic validation that `test` has one owned contact

- [ ] **Step 1: Add failing API and UI-state tests**

Test owner-only mutation, foreign contacts, atomic test-mode validation, retained selection outside test mode, and explicit live confirmation state.

- [ ] **Step 2: Run tests and confirm failure**

Run: `cd server && npx vitest run test/ai-api.test.ts`

Run: `cd rakurs && npx vitest run src/screens/agent-response-mode.test.ts`

- [ ] **Step 3: Implement atomic API validation**

Reject `responseMode: 'test'` unless the effective selected contact belongs to the same agent scope. Return the selected contact summary in settings.

- [ ] **Step 4: Implement the three-state control**

Use Russian product copy. Require a single contact in test mode, show name plus normalized phone, and require a confirmation before saving `Для всех`.

- [ ] **Step 5: Run focused and regression tests**

Run: `cd server && npx vitest run test/automation-policy.test.ts test/ai-api.test.ts test/ai-inbound.test.ts test/ai-turn.test.ts test/linked-inbound.test.ts test/crm-live.test.ts test/crm-worker.test.ts`

Run: `cd rakurs && npx vitest run src/screens/agent-response-mode.test.ts && npm run build`

- [ ] **Step 6: Commit only Task 4 files**

```bash
git commit -m "feat: control WhatsApp response mode"
```

### Task 5: Verify the safety milestone

**Files:**
- Modify only if a failing test reveals a defect in Task 1–4 scope

- [ ] **Step 1: Run complete server verification**

Run: `cd server && npm run typecheck && npm test && npm run build`

- [ ] **Step 2: Run complete frontend verification**

Run: `cd rakurs && npm run typecheck && npm test && npm run build`

- [ ] **Step 3: Inspect the final diff for unrelated changes**

Run: `git status --short` and `git diff --check`.

- [ ] **Step 4: Stop after the independently usable milestone**

Report exact passing commands and any pre-existing failures. Do not begin simulator work until this milestone is reviewed.
