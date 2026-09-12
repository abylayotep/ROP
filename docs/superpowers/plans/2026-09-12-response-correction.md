# AI Response Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn feedback on a specific live or sandbox AI response into an editable, regression-tested draft that a human explicitly applies.

**Architecture:** Resolve response context and knowledge evidence on the server, persist an immutable feedback snapshot, and let coach produce a versioned editable proposal. Draft creation consumes the saved revision and requires the originating scenario in the regression run.

**Tech Stack:** TypeScript, Fastify, Drizzle ORM, PostgreSQL, React, Vitest

**Spec:** `docs/superpowers/specs/2026-09-12-whatsapp-test-mode-and-coaching-design.md`

## Global Constraints

- Feedback never changes knowledge or rules automatically.
- Response and knowledge ownership is validated server-side.
- Edited proposal content is the content stored in the draft.
- The originating scenario must pass before apply.
- Stale config or content blocks apply.
- Preserve unrelated working-tree changes and the 500-line Markdown cap.

---

### Task 1: Model response-bound feedback

**Files:**
- Modify: `server/src/db/schema.ts`
- Create: next generated Drizzle migration and snapshot
- Modify: `packages/contract/index.ts`
- Test: `server/test/coach-api.test.ts`

**Interfaces:**
- Produces: `CoachSource = { kind: 'conversation_reply'; conversationId: string; aiReplyId: string } | { kind: 'sandbox_turn'; sessionId: string; turnId: string }`
- Produces: `CorrectionType = 'fact' | 'behavior'`
- Extends coach messages with revision and immutable source snapshot

- [ ] **Step 1: Add failing constraints and contract tests**

Test exactly one source kind, initial revision `1`, immutable snapshot, and tenant/agent scoping.

- [ ] **Step 2: Run the focused test and confirm failure**

Run: `cd server && npx vitest run test/coach-api.test.ts`

- [ ] **Step 3: Add schema and contract shapes**

```ts
export type CoachFeedbackRequest = {
  source: CoachSource;
  correctionType: 'fact' | 'behavior';
  note: string;
};
```

Snapshot bounded transcript text, response text, config version, and verified source records. Do not store or return secrets or complete internal prompts.

- [ ] **Step 4: Generate migration and rerun tests/typecheck**

Run: `cd server && npx vitest run test/coach-api.test.ts && npm run typecheck`

- [ ] **Step 5: Commit Task 1 files**

```bash
git commit -m "feat: bind coaching feedback to AI responses"
```

### Task 2: Resolve evidence and generate safe proposals

**Files:**
- Modify: `server/src/api/coach.ts`
- Modify: `server/src/lib/ai/coach.ts`
- Modify: `server/src/lib/ai/fact-check.ts`
- Test: `server/test/coach-call.test.ts`
- Test: `server/test/coach-fact-check.test.ts`
- Test: `server/test/coach-api.test.ts`

**Interfaces:**
- Extends: `POST /api/agents/:agentId/coach/messages` with response-bound feedback
- Produces: verified evidence records containing chunk, note, path, title, heading, and bounded content

- [ ] **Step 1: Write failing ownership/evidence tests**

Cover live and sandbox sources, foreign IDs returning `404`, cited chunk-to-note resolution, prompt-injection text treated as data, factual proposals targeting notes, and behavior proposals targeting rules.

- [ ] **Step 2: Run tests and confirm failure**

Run: `cd server && npx vitest run test/coach-call.test.ts test/coach-fact-check.test.ts test/coach-api.test.ts`

- [ ] **Step 3: Replace title-only source context with verified evidence**

Resolve cited chunk IDs to agent-owned knowledge notes on the server. Bound transcript and evidence length before constructing coach input.

- [ ] **Step 4: Generate proposal by correction type**

Allow only `rule`, `rule_edit`, `note`, and `note_edit` proposal shapes. Run existing proposal validation plus ownership validation before persistence.

- [ ] **Step 5: Run focused tests and commit**

Run the command from Step 2, then commit:

```bash
git commit -m "feat: generate response correction proposals"
```

### Task 3: Persist proposal edits and create exact drafts

**Files:**
- Modify: `server/src/api/coach.ts`
- Modify: `packages/contract/index.ts`
- Modify: `rakurs/src/api/index.ts`
- Modify: `rakurs/src/components/coach/ProposalCard.tsx`
- Create: `rakurs/src/components/coach/proposal.ts`
- Create: `rakurs/src/components/coach/proposal.test.ts`
- Test: `server/test/coach-api.test.ts`

**Interfaces:**
- Produces: `PATCH /coach/messages/:id/proposal` body `{ revision, proposal }`
- Changes: `POST /coach/messages/:id/draft` body `{ revision }`

- [ ] **Step 1: Add failing revision and edited-content tests**

Prove that pending proposals can be edited, stale revisions return `409`, invalid targets fail, accepted/rejected messages cannot be edited, and draft ops match the saved edited proposal exactly.

- [ ] **Step 2: Run server and component tests and confirm failure**

Run: `cd server && npx vitest run test/coach-api.test.ts`

Run: `cd rakurs && npx vitest run src/components/coach/proposal.test.ts`

- [ ] **Step 3: Implement versioned proposal editing**

Validate the entire proposal on every patch, increment revision atomically, and return the saved message. Draft creation must accept only the current revision.

- [ ] **Step 4: Wire the textarea to persisted edits**

Track dirty/saving/conflict state. Disable draft creation until the edit is saved. On `409`, reload and keep the user's unsaved text visible for manual reconciliation.

- [ ] **Step 5: Run tests and commit**

Run both Step 2 commands, then commit:

```bash
git commit -m "fix: persist edited coaching proposals"
```

### Task 4: Require the originating regression case

**Files:**
- Modify: `server/src/api/test-cases.ts`
- Modify: `server/src/api/drafts.ts`
- Modify: `server/src/lib/drafts/applicable.ts`
- Modify: `packages/contract/index.ts`
- Test: `server/test/test-cases-api.test.ts`
- Test: `server/test/draft-apply-api.test.ts`

**Interfaces:**
- Produces: a draft-linked required case derived from the immutable feedback snapshot
- Changes: apply eligibility to require a successful current-version result for that case

- [ ] **Step 1: Add failing required-case tests**

Test automatic case creation, inclusion in runs, rejection when omitted or failed, success when passed, and stale-config rejection.

- [ ] **Step 2: Run tests and confirm failure**

Run: `cd server && npx vitest run test/test-cases-api.test.ts test/draft-apply-api.test.ts`

- [ ] **Step 3: Create the case with the draft**

Derive messages and expected correction criteria from the saved snapshot. Link the case to the draft; do not rely on client-supplied transcript content.

- [ ] **Step 4: Enforce the case in run and apply**

Ensure run selection always contains required case IDs and `applicable` verifies their successful results at the current config version.

- [ ] **Step 5: Run tests and commit**

Run the command from Step 2, then commit:

```bash
git commit -m "feat: require correction regression cases"
```

### Task 5: Connect live and sandbox correction UI

**Files:**
- Modify: `rakurs/src/screens/DialogsScreen.tsx`
- Modify: `rakurs/src/screens/TestScreen.tsx`
- Modify: `rakurs/src/screens/CoachScreen.tsx`
- Modify: `rakurs/src/screens/DraftScreen.tsx`
- Modify: `rakurs/src/api/index.ts`
- Create: `rakurs/src/screens/response-feedback.ts`
- Create: `rakurs/src/screens/response-feedback.test.ts`

**Interfaces:**
- Consumes: response-bound feedback and versioned proposal routes
- Produces: `Исправить ответ` flow for live and sandbox replies

- [ ] **Step 1: Write failing UI-state tests**

Cover both source kinds, correction type, required note, source display, proposal edit/save, draft creation, required regression status, and apply handoff.

- [ ] **Step 2: Run tests and confirm failure**

Run: `cd rakurs && npx vitest run src/screens/response-feedback.test.ts src/components/coach/proposal.test.ts`

- [ ] **Step 3: Add the correction panel**

Use Russian product strings. Display the selected answer, preceding context, verified sources, `Неверная информация` / `Неверное поведение`, and the operator note.

- [ ] **Step 4: Connect review and apply states**

Navigate or expand into existing coach/draft review without applying automatically. Show required-case failure and stale conflicts as actionable states.

- [ ] **Step 5: Run frontend verification and commit**

Run: `cd rakurs && npx vitest run src/screens/response-feedback.test.ts src/components/coach/proposal.test.ts && npm run typecheck && npm run build`

```bash
git commit -m "feat: add response correction workflow"
```

### Task 6: Verify correction safety end to end

**Files:**
- Modify only for defects within this plan

- [ ] **Step 1: Run complete server verification**

Run: `cd server && npm run typecheck && npm test && npm run build`

- [ ] **Step 2: Run complete frontend verification**

Run: `cd rakurs && npm run typecheck && npm test && npm run build`

- [ ] **Step 3: Review final behavior**

Confirm no feedback path applies automatically, foreign IDs disclose nothing, edited content reaches the draft, and the originating case must pass.

- [ ] **Step 4: Inspect the diff**

Run: `git status --short` and `git diff --check`; report any pre-existing failures separately.
