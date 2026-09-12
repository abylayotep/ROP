# WhatsApp Simulator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an isolated, multi-turn WhatsApp-style simulator that exercises production AI behavior without external or production writes.

**Architecture:** Store sandbox sessions and turns separately from production conversations. Execute each turn through shared prompt, retrieval, parsing, and validation code while capturing proposed effects into sandbox state.

**Tech Stack:** TypeScript, Fastify, Drizzle ORM, PostgreSQL, React, Vitest

**Spec:** `docs/superpowers/specs/2026-09-12-whatsapp-test-mode-and-coaching-design.md`

## Global Constraints

- All simulator routes are owner-only and tenant-scoped.
- No WhatsApp, CRM, checkout, handoff, production conversation, or production analytics writes.
- Text-only simulation in this release.
- Preserve the existing one-shot sandbox route until its UI migration is complete.
- Keep maintained Markdown files below 500 lines and preserve unrelated changes.

---

### Task 1: Add isolated sandbox persistence

**Files:**
- Modify: `server/src/db/schema.ts`
- Create: next generated Drizzle migration and snapshot
- Modify: `packages/contract/index.ts`
- Test: `server/test/ai-simulator-api.test.ts`

**Interfaces:**
- Produces: `AiSandboxSessionSummary`, `AiSandboxSessionDetail`, and `AiSandboxTurn`
- Produces: session state with revision, simulated stage, fields, outcome, and handoff

- [ ] **Step 1: Write failing persistence and ownership tests**

Assert separate tables, agent ownership, revision increments, ordered turns, and cascade cleanup without production rows.

- [ ] **Step 2: Run the focused test and confirm failure**

Run: `cd server && npx vitest run test/ai-simulator-api.test.ts`

- [ ] **Step 3: Add sandbox tables and contracts**

```ts
export type AiSandboxTurnRequest = { text: string; revision: number };
export type AiSandboxCreateRequest = { title?: string; phone?: string };
```

Store source IDs and proposed effects as validated JSON shapes already used by `AiTurn`; do not store opaque arbitrary model output.

- [ ] **Step 4: Generate migration and rerun tests/typecheck**

Run: `cd server && npx vitest run test/ai-simulator-api.test.ts && npm run typecheck`

- [ ] **Step 5: Commit Task 1 files**

```bash
git commit -m "feat: persist isolated AI sandbox sessions"
```

### Task 2: Build the production-equivalent simulator runner

**Files:**
- Create: `server/src/lib/ai/simulator.ts`
- Modify: `server/src/lib/ai/turn.ts`
- Test: `server/test/ai-simulator.test.ts`
- Test: `server/test/draft-replay.test.ts`
- Test: `server/test/turn-cap.test.ts`

**Interfaces:**
- Produces: `runSimulatorTurn(db, deps, { agentId, sessionId, text, revision }): Promise<AiSandboxTurn>`
- Reuses: production prompt assembly, KB retrieval, response parsing, fact validation, and turn caps

- [ ] **Step 1: Write failing multi-turn and no-write tests**

The second turn must see the first reply and simulated state. Assert no production message, contact, lead, order, outbound transport, or analytics row is created.

- [ ] **Step 2: Run tests and confirm failure**

Run: `cd server && npx vitest run test/ai-simulator.test.ts test/draft-replay.test.ts test/turn-cap.test.ts`

- [ ] **Step 3: Extract only the reusable AI core needed by both paths**

Keep live orchestration in `runTurn`. Introduce a focused internal execution function that accepts history and state and returns reply plus proposed effects; do not add a provider abstraction.

- [ ] **Step 4: Implement optimistic multi-turn execution**

Reject a stale revision with `409`. Persist the user and assistant turn, source IDs, model/config version, and proposed effects in one transaction, then advance simulated state and revision.

- [ ] **Step 5: Run focused tests**

Run the command from Step 2 and require all tests to pass.

- [ ] **Step 6: Commit Task 2 files**

```bash
git commit -m "feat: run multi-turn AI simulations"
```

### Task 3: Add sandbox session APIs

**Files:**
- Create: `server/src/api/ai-sandbox.ts`
- Modify: `server/src/api/server.ts`
- Modify: `rakurs/src/api/index.ts`
- Test: `server/test/ai-simulator-api.test.ts`

**Interfaces:**
- Produces: list/create/detail/turn routes under `/api/agents/:agentId/ai/sandbox/sessions`
- Consumes: `runSimulatorTurn`

- [ ] **Step 1: Add failing route tests**

Cover list, create, detail, ordered turns, send, limits, stale revision, invalid IDs, owner-only access, and cross-tenant not-found behavior.

- [ ] **Step 2: Run API tests and confirm failure**

Run: `cd server && npx vitest run test/ai-simulator-api.test.ts`

- [ ] **Step 3: Implement routes with existing auth and rate-limit patterns**

Validate text at 1–4,000 characters. Return `404` for foreign resources and `409` for stale revision. Leave the old `POST /ai/sandbox` route working.

- [ ] **Step 4: Run API tests and typecheck**

Run: `cd server && npx vitest run test/ai-simulator-api.test.ts && npm run typecheck`

- [ ] **Step 5: Commit Task 3 files**

```bash
git commit -m "feat: expose sandbox session APIs"
```

### Task 4: Build the WhatsApp-style testing screen

**Files:**
- Create: `rakurs/src/screens/TestScreen.tsx`
- Create: `rakurs/src/screens/test-chat.ts`
- Create: `rakurs/src/screens/test-chat.test.ts`
- Modify: `rakurs/src/lib/sections.ts`
- Modify: `rakurs/src/App.tsx`
- Modify: `rakurs/src/api/index.ts`

**Interfaces:**
- Consumes: sandbox session APIs and `AiSandboxTurn`
- Produces: `Тестирование` navigation section

- [ ] **Step 1: Write failing state-helper tests**

Test ordered rendering, pending send, retry after error, revision conflicts, selected turn effects, new session, and immutable warning copy.

- [ ] **Step 2: Run tests and confirm failure**

Run: `cd rakurs && npx vitest run src/screens/test-chat.test.ts`

- [ ] **Step 3: Implement screen state and API integration**

Keep server turns authoritative. Disable duplicate sends while pending and reload the session after `409` without silently resending text.

- [ ] **Step 4: Implement the UI**

Render session list, WhatsApp-style bubbles, composer, `Новый тест`, persistent `Тест — сообщения не отправляются в WhatsApp`, sources/effects inspector, `Исправить ответ`, and `Сохранить как тест-кейс`.

- [ ] **Step 5: Run frontend verification**

Run: `cd rakurs && npx vitest run src/screens/test-chat.test.ts && npm run typecheck && npm run build`

- [ ] **Step 6: Commit Task 4 files**

```bash
git commit -m "feat: add WhatsApp testing workspace"
```

### Task 5: Verify simulator isolation

**Files:**
- Modify only for defects within this plan

- [ ] **Step 1: Run complete server tests**

Run: `cd server && npm run typecheck && npm test && npm run build`

- [ ] **Step 2: Run complete frontend tests**

Run: `cd rakurs && npm run typecheck && npm test && npm run build`

- [ ] **Step 3: Inspect database-side effects in integration tests**

Require explicit zero counts for production messages, contacts, leads, orders, and outbound calls after a multi-turn session.

- [ ] **Step 4: Stop at the simulator milestone**

Report exact checks and pre-existing failures before starting correction workflow work.
