# Draft Autopilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Started on: Opus 5 · Subtasks: Opus 5, high effort, every task (session model governs).

**Goal:** One button on the draft screen that picks cases, cleans topics, runs, rewrites or removes the topics that made answers worse, reruns, and applies the draft when nothing is worse.

**Architecture:** A `draft_autopilots` row holds the whole state; a 5 s drain in `index.ts` advances each running row by one step, calling the same run/apply/op-edit functions the routes use (moved from `api/drafts.ts` into `lib/drafts/`). Attribution of a bad answer to a topic comes from a new `test_results.used_op_indexes` column filled by `replayCase`.

**Tech Stack:** Fastify, Drizzle + Postgres, zod, vitest; React + Vite in `rakurs/`; shared types in `packages/contract/index.ts`.

**Spec:** `docs/superpowers/specs/2026-09-14-draft-autopilot-design.md` — read it first; this plan does not repeat its step rules.

Tasks 1–3 are here. Tasks 4–5 are in `2026-09-14-draft-autopilot-part2.md`.

## Global Constraints

- Everything in the repo is English (code, comments, tests, commits). Owner-facing strings (log lines, stop reasons, UI, API error messages) are Russian, exactly as the spec words them.
- Existing error messages and status codes of the draft routes stay byte-for-byte identical.
- `MAX_CASES = 20`. Max draft runs per autopilot = 4. Topic rewrites before removal = 2. Run failures before stop = 3. Log capped at 50 entries.
- Match the surrounding comment style: comments explain *why*, not *what*. Do not copy the very long essays in `api/drafts.ts`; a short paragraph is enough.
- Commits end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

## Environment facts every worker needs

- Test DB: `docker compose -f deploy/compose.test.yml up -d` (colima must be running; starting colima fails inside the Bash sandbox).
- The Bash sandbox blocks localhost TCP: every DB-touching command, vitest included, needs `dangerouslyDisableSandbox: true`, otherwise `connect EPERM 127.0.0.1:55432`. That error is the sandbox, not a broken DB.
- `npm install` in a fresh worktree: `npm install --cache "$TMPDIR/npm-cache"` from the repo root (workspaces share the root lockfile; never `npm --prefix … install`).
- Flaky on wall clock, ignore a single failure that passes on rerun: `capi-queue`, `session`, `whatsapp-inbound`, `knowledge-import-text`.
- Server tests: `npm --prefix server test -- <file>`. Frontend tests: `npm --prefix rakurs test -- <file>`. Typecheck: `npm --prefix server run typecheck` (check the script name in `server/package.json`) and `npm --prefix rakurs run typecheck`.
- Server tests live in `server/test/*.test.ts` and use `server/test/helpers/db.ts` (`withDb`). Read `server/test/draft-run-api.test.ts` and `draft-replay.test.ts` for how agents, numbers, cases and fake models are set up; reuse those fixtures rather than inventing new ones.

## File map

| File | Responsibility |
|---|---|
| `server/drizzle/0046_draft_autopilot.sql` + meta | column + table (Task 1) |
| `server/src/db/schema.ts` | `testResults.usedOpIndexes`, `draftAutopilots` (Task 1) |
| `server/src/lib/drafts/replay.ts` | return `usedOpIndexes` (Task 1) |
| `server/src/lib/drafts/run.ts` | `startDraftRun`, `isDraftRunning`, `runReplay` (Task 2) |
| `server/src/lib/drafts/apply.ts` | `applyDraft` (Task 2) |
| `server/src/lib/drafts/edit-op.ts` | `editDraftOp`, `topicKey`, `opTitle` (Task 2) |
| `server/src/api/drafts.ts` | thin routes (Task 2), autopilot routes + 409 guards (Task 4) |
| `server/src/lib/drafts/topic-fix.ts` | `cleanTopic`, `rewriteTopic`, number guard (Task 3) |
| `server/src/lib/drafts/autopilot.ts` | engine (Task 4) |
| `server/src/index.ts` | drain timer (Task 4) |
| `packages/contract/index.ts` | `usedOpIndexes`, `DraftAutopilot` (Tasks 1, 4) |
| `rakurs/src/components/drafts/RunTable.tsx` | topic labels from `usedOpIndexes` (Task 1) |
| `rakurs/src/components/drafts/AutopilotPanel.tsx`, `screens/DraftScreen.tsx`, `api` client | UI (Task 5) |

---

### Task 1: Attribute a reply to draft topics

**Files:**
- Create: `server/drizzle/0046_draft_autopilot.sql` (+ journal/snapshot via the repo's drizzle-kit generate script; check `server/package.json` for its name and follow how 0045 was produced)
- Modify: `server/src/db/schema.ts` (`testResults` near line 1372; new `draftAutopilots` table)
- Modify: `server/src/lib/drafts/replay.ts` (`ReplayResult`, `replayCase` ~line 249)
- Modify: `server/src/api/drafts.ts` (`CaseSide`, `sideFromReplay`, `sideFromRow`, `resultRow`)
- Modify: `packages/contract/index.ts` (`TestCaseSide`)
- Modify: `rakurs/src/components/drafts/RunTable.tsx` (~lines 53–110, 175–180)
- Test: `server/test/draft-replay.test.ts`, `server/test/draft-run-api.test.ts`

**Interfaces:**
- Produces: `ReplayResult.usedOpIndexes: number[]`; column `test_results.used_op_indexes`; `TestCaseSide.usedOpIndexes: number[]`; Drizzle table `draftAutopilots` with the columns in the spec's Data model (camelCase fields: `agentId, draftId, createdBy, status, step, caseIds, runId, runOps, runsStarted, runFailures, noiseRetryUsed, topicAttempts, pendingFixes, log, cost, stopReason, createdAt, updatedAt, finishedAt`).

- [ ] **Step 1: Failing replay test.** In `draft-replay.test.ts`, add a test that replays a case against `[{op:'note_update', noteId: existing.id, body}, {op:'note_create', path:'Доставка', body:'Доставка 1000 тенге'}]` with a fake model whose turn cites both notes' chunk ids (follow how existing tests make the model return `usedChunkIds`; for the created note, the fake must read the id from the transaction — look at how the existing `note_create` replay test finds it). Expect `result.usedOpIndexes` toEqual `[0, 1]`. Add a second test: reply citing only a note not in the ops → `[]`.
- [ ] **Step 2: Run** `npm --prefix server test -- draft-replay` → FAIL (`usedOpIndexes` undefined).
- [ ] **Step 3: Implement.** In `replayCase`:

```ts
const noteOpIndex = new Map<string, number>();
await applyOps(tx as unknown as Db, input.agentId, input.ops, (opIndex, noteId) => {
  noteOpIndex.set(noteId, opIndex);
});
// …after the last turn, where usedChunkIds is read:
const usedOpIndexes = [...new Set(usedChunkIds.flatMap((id) => {
  const index = noteOpIndex.get(id);
  return index === undefined ? [] : [index];
}))].sort((a, b) => a - b);
```

Check in `ops.ts` that `onNoteApplied` fires for both `note_create` and `note_update`; if it only fires for one, make it fire for both (the apply route's callback only updates proposals by op index, so firing for updates is harmless — verify against `draft-apply-api.test.ts`).
- [ ] **Step 4: Migration + schema.** SQL exactly as in the spec's Data model. Drizzle: `usedOpIndexes: integer('used_op_indexes').array().notNull().default(sql\`'{}'\`)`. Add `draftAutopilots` with jsonb `$type<>()` annotations: `runOps: DraftOp[] | null`, `topicAttempts: Record<string, number>`, `pendingFixes: PendingFix[] | null`, `log: AutopilotLogEntry[]`. Define and export `PendingFix` and `AutopilotLogEntry` types in `schema.ts` or a small `lib/drafts/autopilot-types.ts` (prefer the latter; import type into schema).

```ts
export type AutopilotLogKind = 'info' | 'fix' | 'remove' | 'warn';
export interface AutopilotLogEntry { at: string; kind: AutopilotLogKind; text: string }
export interface FailingCase { title: string; messages: string[]; before: string | null; after: string | null; reason: string | null }
export interface PendingFix { key: string; action: 'rewrite' | 'remove'; cases: FailingCase[] }
```

- [ ] **Step 5: Thread the field through `api/drafts.ts`:** add `usedOpIndexes` to `CaseSide`, `sideFromReplay`, `sideFromRow` (`row.usedOpIndexes`), `resultRow`. Add `usedOpIndexes: number[]` to `TestCaseSide` in the contract.
- [ ] **Step 6: Run test extension.** In `draft-run-api.test.ts` extend one existing done-run assertion to check `after.usedOpIndexes` is an array and `before.usedOpIndexes` is `[]`.
- [ ] **Step 7: RunTable labels.** `RunTable` already receives `run`; give it `ops: DraftOp[]` and `base` (pass `draft.ops`, `draft.base` from `DraftScreen`). For each `after.usedOpIndexes` index render the op title: `note_create` → last path segment of `path`; `note_update` → `base.noteNames?.[noteId] ?? 'Заметка'`. Keep existing chips for ids not covered by an op index (real notes resolved through `notes.data`). Drop the «новая заметка черновика» fallback for ids that an op index already covered. Update `DraftScreen.tsx` call site.
- [ ] **Step 8: Verify.** `npm --prefix server test -- draft-replay draft-run-api draft-apply-api drafts-schema` (sandbox off) → PASS. `npm --prefix rakurs test` and both typechecks → PASS.
- [ ] **Step 9: Commit** `feat(drafts): record which draft topics a replayed answer used`.

---

### Task 2: Move run, apply and op edit into `lib/drafts/`

Pure move. Behaviour, messages and status codes unchanged. The existing tests are the net.

**Files:**
- Create: `server/src/lib/drafts/run.ts`, `apply.ts`, `edit-op.ts`
- Modify: `server/src/api/drafts.ts` (routes at lines ~702–997, 1109–1231, 1300–1375)
- Test: existing `server/test/draft-run-api.test.ts`, `draft-apply-api.test.ts`, plus whatever file covers `/ops` (grep `drafts/.*/ops` in `server/test`)

**Interfaces:**
- Produces:

```ts
// run.ts
export interface RunContext { db: Db; deps: AiDeps; key: Buffer; log: (obj: object, msg: string) => void }
export interface RunAgent { id: string; configVersion: number; model: string; temperature: string; openrouterKey: string | null }
export function isDraftRunning(draftId: string): boolean;
export async function startDraftRun(ctx: RunContext, input: { agent: RunAgent; draft: typeof kbDrafts.$inferSelect; caseIds: string[] }): Promise<TestRun>;
// apply.ts
export async function applyDraft(db: Db, input: { agentId: string; draftId: string }): Promise<typeof kbDrafts.$inferSelect>;
// edit-op.ts
export type OpEdit = { action: 'remove'; index: number; current: unknown } | { action: 'update'; index: number; current: unknown; body: string };
export async function editDraftOp(db: Db, input: { agentId: string; draftId: string; edit: OpEdit }): Promise<typeof kbDrafts.$inferSelect>;
export function topicKey(op: DraftOp): string | null; // 'path:<path>' | 'note:<noteId>' | null for rules
export function opTitle(op: DraftOp, base: DraftBase): string; // move `titleFor` here and re-export for the route
```

`RunAgent` fields: take them from what `req.agent` provides today (check its type in `require-agent.ts`; use the same field types).

- [ ] **Step 1: Baseline.** Run `npm --prefix server test -- draft` (sandbox off). Record the pass count.
- [ ] **Step 2: Move `runReplay`, `runningDrafts`, `MAX_CASES`, `resultRow`, `sideFromReplay`, `missingRowMessage`, `DUPLICATE_NOTE_PATH_MESSAGE`, `ownNumber`, `CaseSide`** into `run.ts`. The run route body from `if (runningDrafts.has…)` to the returned object becomes `startDraftRun`. Replace `app.log.error` with `ctx.log`. The route becomes: load draft, parse body (keep the 400 message), `return startDraftRun({db, deps, key, log: (o, m) => app.log.error(o, m)}, { agent: req.agent!, draft, caseIds: parsed.data.caseIds })`. Keep the body parse *after* the running check, as today — so `startDraftRun` does the running check and the route passes the raw body's parse result; simplest faithful form: move `runBody.safeParse` into `startDraftRun` by accepting `caseIds: unknown` and parsing there. Keep the ordering exactly.
- [ ] **Step 3: Move the apply transaction** into `applyDraft`; route keeps `loadDraft` then calls it and returns `toDraft(row)`.
- [ ] **Step 4: Move the op-edit transaction** (including `canonicalJson`, `pruneBase`) into `editDraftOp`; route keeps parse + `loadDraft`, the `runningDrafts` check becomes `isDraftRunning(draftId)` and stays in the route (the engine only edits when no run is in flight, by construction).
- [ ] **Step 5: Add `topicKey`** with a unit test in `server/test/draft-ops.test.ts`: note_create → `path:Доставка`, note_update → `note:<id>`, rule ops → `null`.
- [ ] **Step 6: Verify** the same test command → same pass count, zero new failures; typecheck passes.
- [ ] **Step 7: Commit** `refactor(drafts): move run, apply and op edit into lib for reuse`.

---

### Task 3: Topic clean-up and rewrite helpers

**Files:**
- Create: `server/src/lib/drafts/topic-fix.ts`
- Modify: `server/src/lib/drafts/suggest.ts` (return cost)
- Test: `server/test/draft-topic-fix.test.ts`

**Interfaces:**
- Consumes: `ModelClient` (`lib/ai/openrouter.ts`), `extractJson` (same helper `suggest.ts` imports), `BODY_MAX` (`lib/knowledge/note.ts`), `addCost` (`lib/ai/turn.ts`), `FailingCase` (Task 1).
- Produces:

```ts
export interface TopicFixDeps { model: ModelClient; key: string; modelId: string; temperature: string }
export interface TopicFixResult { body: string; reason: string; cost: string }
export class TopicFixError extends Error { constructor(readonly code: 'malformed_output' | 'invented_number' | 'too_long' | 'empty', readonly cost: string) }
export const TOPIC_FIX_INPUT_MAX = 8_000;
export function inventedNumbers(before: string, after: string): string[];
export async function cleanTopic(deps: TopicFixDeps, input: { title: string; body: string }): Promise<TopicFixResult>;
export async function rewriteTopic(deps: TopicFixDeps, input: { title: string; body: string; cases: FailingCase[] }): Promise<TopicFixResult>;
// suggest.ts: suggestCases now returns { cases: SuggestedCase[]; cost: string } — update the one route caller in api/test-cases.ts
```

- [ ] **Step 1: Failing tests** (no DB needed):

```ts
import { describe, expect, it } from 'vitest';
import { cleanTopic, inventedNumbers, rewriteTopic, TopicFixError } from '../src/lib/drafts/topic-fix.js';

const fakeModel = (text: string) => ({ complete: async () => ({ text, cost: '0.001' }) }) as never;
const deps = (text: string) => ({ model: fakeModel(text), key: 'k', modelId: 'm', temperature: '0.2' });

describe('inventedNumbers', () => {
  it('lists digit runs absent from the original', () => {
    expect(inventedNumbers('Задаток 3000 тг, +77066241022', 'Задаток 3000 тг, доставка 1000')).toEqual(['1000']);
  });
  it('accepts reformatted but identical numbers', () => {
    expect(inventedNumbers('цена 9 990 тг', 'цена 9990 тг')).toEqual([]);
  });
});

describe('cleanTopic', () => {
  it('returns the cleaned body and reason', async () => {
    const out = await cleanTopic(deps('{"body":"## Факты\\n- Задаток 3000 тг","reason":"Убраны реплики из переписки"}'),
      { title: 'Оплата', body: '## Факты\n- Задаток 3000 тг\n- Тапсырыс бересіз бе?🤗' });
    expect(out.body).toBe('## Факты\n- Задаток 3000 тг');
    expect(out.cost).toBe('0.001');
  });
  it('rejects an invented price', async () => {
    await expect(cleanTopic(deps('{"body":"Задаток 5000 тг","reason":"x"}'), { title: 't', body: 'Задаток 3000 тг' }))
      .rejects.toMatchObject({ code: 'invented_number' });
  });
  it('rejects malformed output and keeps its cost', async () => {
    await expect(cleanTopic(deps('not json'), { title: 't', body: 'b' })).rejects.toBeInstanceOf(TopicFixError);
  });
});

describe('rewriteTopic', () => {
  it('sends the failing case to the model', async () => {
    let seen = '';
    const model = { complete: async (i: { messages: { content: string }[] }) => { seen = JSON.stringify(i.messages); return { text: '{"body":"Оформление: размер, дизайн, задаток 3000","reason":"Убрана реплика"}', cost: '0' }; } } as never;
    await rewriteTopic({ model, key: 'k', modelId: 'm', temperature: '0.2' }, { title: 'Оформление заказа', body: 'Тапсырыс бересіз бе? задаток 3000',
      cases: [{ title: 'Запрос на оформление', messages: ['Хочу заказать'], before: 'Уточню', after: 'Тапсырыс бересіз бе?', reason: 'Нет информации' }] });
    expect(seen).toContain('Хочу заказать');
    expect(seen).toContain('Нет информации');
  });
});
```

Check the real `Completion` shape in `openrouter.ts` (`text`, `cost` field names) and adjust the fake accordingly before running.
- [ ] **Step 2: Run** `npm --prefix server test -- draft-topic-fix` → FAIL (module missing).
- [ ] **Step 3: Implement.** `inventedNumbers`: strip spaces between digits (`/(\d)[\s ](?=\d)/g` → `$1`), collect `/\d+/g` from both, return after-runs not in the before set (deduplicated, in order). Output schema `z.object({ body: z.string(), reason: z.string() })`. Order of guards after parse: empty trimmed body → `empty`; `> BODY_MAX` → `too_long`; invented numbers → `invented_number`. Inputs over `TOPIC_FIX_INPUT_MAX` throw `too_long` with cost `'0'` before calling the model. Unchanged body (trimmed equal) returns `{ body: input.body, reason: '', cost }`.

System prompt for `cleanTopic` (English, one constant):

```
You maintain one topic of a sales agent's knowledge base. The topic was generated from real customer chats and may contain dialogue instead of knowledge.
Remove: verbatim customer or manager chat lines, questions addressed to a customer, greetings, emojis, and anything that is conversation rather than a fact about the business. Remove them from "## Факты" and from free text.
Keep: every price, amount, phone number, address, bank, schedule, deadline and condition exactly as written. Keep existing "##" headings. "## Готовые фразы" may keep reusable replies in any language, including Kazakh.
Never add information that is not already in the topic. Write in the language(s) the topic already uses.
Answer with one JSON object: {"body": "<full new topic markdown>", "reason": "<one short Russian sentence on what you removed, empty if nothing>"}.
```

`rewriteTopic` system prompt: same Keep/Never-add rules, plus: `The agent answered the cases below worse with this topic than without it. Rewrite the topic so an agent reading it answers these cases well: reorganise, clarify, and drop the lines that caused the bad answer. "reason": one short Russian sentence on what you changed.` User message: the topic title and body, then each case as `Customer: …`, `Before: …`, `After (worse): …`, `Judge: …`.
- [ ] **Step 4: `suggestCases` cost.** Return `{ cases, cost: completion.cost }`; update `api/test-cases.ts` to read `.cases`. Run its existing test.
- [ ] **Step 5: Verify** `npm --prefix server test -- draft-topic-fix test-cases` → PASS; typecheck.
- [ ] **Step 6: Commit** `feat(drafts): add topic clean-up and rewrite helpers with a no-new-numbers guard`.
