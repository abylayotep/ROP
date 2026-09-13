# Draft Autopilot Implementation Plan — Part 2 (Tasks 4–5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Read first: `2026-09-14-draft-autopilot.md` (header, Global Constraints, Environment facts, File map, Tasks 1–3 interfaces) and the spec `docs/superpowers/specs/2026-09-14-draft-autopilot-design.md` (Engine and API sections are the source of truth for step rules and Russian strings).

---

### Task 4: Autopilot engine, drain and routes

**Files:**
- Create: `server/src/lib/drafts/autopilot.ts`
- Modify: `server/src/api/drafts.ts` (three routes; 409 guard on run, apply, discard, ops)
- Modify: `server/src/index.ts` (drain timer next to the CRM timer, ~line 174)
- Modify: `packages/contract/index.ts` (`DraftAutopilot`)
- Test: `server/test/draft-autopilot.test.ts`, `server/test/draft-autopilot-api.test.ts`

**Interfaces:**
- Consumes: `startDraftRun`, `isDraftRunning`, `RunContext`, `RunAgent` (run.ts); `applyDraft` (apply.ts); `editDraftOp`, `topicKey`, `opTitle` (edit-op.ts); `cleanTopic`, `rewriteTopic`, `TopicFixError` (topic-fix.ts); `suggestCases` returning `{cases, cost}`; `isDraftApplicable`; `draftAutopilots`, `PendingFix`, `FailingCase`, `AutopilotLogEntry` (Task 1); `ApiError` (`lib/errors.ts`); `decryptSecret`, `keyAad` as the run route uses them.
- Produces:

```ts
export const AUTOPILOT_MAX_RUNS = 4;
export const AUTOPILOT_MAX_REWRITES = 2;
export const AUTOPILOT_MAX_RUN_FAILURES = 3;
export interface AutopilotOps {
  startRun: typeof startDraftRun;
  apply: typeof applyDraft;
  editOp: typeof editDraftOp;
  cleanTopic: typeof cleanTopic;
  rewriteTopic: typeof rewriteTopic;
  suggestCases: typeof suggestCases;
}
export interface AutopilotDeps extends RunContext { ops: AutopilotOps }
export const defaultAutopilotOps: AutopilotOps;
export async function advanceAutopilot(deps: AutopilotDeps, id: string): Promise<void>;
export async function drainAutopilots(deps: AutopilotDeps): Promise<void>;
export function isAutopilotBusy(db: Db, draftId: string): Promise<boolean>;
export function toAutopilotDto(row: typeof draftAutopilots.$inferSelect): DraftAutopilot;
```

Contract:

```ts
export type AutopilotStatus = 'running' | 'applied' | 'stopped' | 'cancelled';
export type AutopilotStep = 'prepare_cases' | 'clean_topics' | 'start_run' | 'await_run' | 'fix_topics' | 'apply';
export interface DraftAutopilot {
  id: string; status: AutopilotStatus; step: AutopilotStep;
  runsStarted: number; maxRuns: number; runId: string | null; caseIds: string[];
  log: { at: string; kind: 'info' | 'fix' | 'remove' | 'warn'; text: string }[];
  cost: string; stopReason: string | null; createdAt: string; finishedAt: string | null;
}
```

**Engine shape** (`advanceAutopilot`), one step per call:

```ts
export async function advanceAutopilot(deps: AutopilotDeps, id: string): Promise<void> {
  if (inFlight.has(id)) return;          // module Set: one advance per row at a time in this process
  inFlight.add(id);
  try {
    const row = await load(deps.db, id);
    if (!row || row.status !== 'running') return;
    const draft = await loadDraft(deps.db, row.draftId);
    const agent = await loadAgent(deps.db, row.agentId);
    if (!draft || draft.status !== 'open') return stop(deps.db, row, 'Черновик уже применён или отброшен');
    if (!agent?.openrouterKey) return stop(deps.db, row, 'Нет ключа OpenRouter');
    const patch = await STEPS[row.step as AutopilotStep](deps, row, draft, agent);
    await save(deps.db, row, patch);     // merges fields, appends log (cap 50), sets updated_at
  } catch (error) {
    deps.log({ error, autopilotId: id }, 'draft autopilot: step failed');
    await stopById(deps.db, id, 'Внутренняя ошибка — попробуйте ещё раз');
  } finally {
    inFlight.delete(id);
  }
}
```

Each step function returns a `Patch` (`Partial` row fields + `logs: AutopilotLogEntry[]` + optional `stopReason`/`status`). `stop()` sets `status='stopped'`, `stop_reason`, `finished_at`, and a `warn` log line with the same text. `save` must use `where id = row.id and status = 'running'` so a cancel that landed during the step wins (the patch is dropped). `ApiError` from an op is handled inside the step per the spec (429 / 409-running → no patch, retry next tick; others → stop with `error.message`).

`drainAutopilots`: select ids `where status='running' order by updated_at` and `await advanceAutopilot` each in turn.

`LLM deps` for helpers: `{ model: deps.deps.model, key: decryptSecret(agent.openrouterKey, deps.key, keyAad(agent.id)), modelId: agent.model, temperature: agent.temperature }`. Add every helper's `cost` (including a `TopicFixError.cost`) to `row.cost` with `addCost`.

Case messages for `FailingCase`: read `test_cases.title`/`messages`; `before`/`after`/`reason` from the run's results (use `baselineResults` exactly like the GET run route, or call a small shared `readRunResults(db, run)` extracted from that route in this task).

- [ ] **Step 1: Engine tests first.** `server/test/draft-autopilot.test.ts`, with `withDb`, a seeded agent (with an encrypted OpenRouter key, as `draft-run-api.test.ts` seeds it), a WhatsApp number, an open draft with two `note_create` ops and two enabled cases. Inject fake `ops`:
  - `startRun` fake inserts a `test_runs` row (`status 'running'`, `draftId`) and returns its DTO; the test then marks it `done` and inserts `test_results` with chosen `verdict` and `usedOpIndexes` via a helper `finishRun(runId, [{caseId, verdict, usedOpIndexes}])`.
  - `cleanTopic` fake returns the body unchanged; `rewriteTopic` fake appends ` (исправлено)`; `suggestCases` fake returns `{cases: [], cost: '0'}`.
  - `apply` and `editOp` are the real functions.
  A helper `tick = () => advanceAutopilot(deps, id)` and `rowNow()`.

  Write these tests (each asserts `status`, `step`, and the relevant log `kind`s):
  1. happy path: tick×3 → `await_run`; finish run all `better`; tick → `apply`; tick → `applied`, draft `applied`.
  2. worse on op 1: finish `[better, worse@[1]]`; tick → `fix_topics` with `pendingFixes[0].action 'rewrite'`; tick → op 1 body ends with `(исправлено)`, `topicAttempts['path:<p>'] === 1`, step `start_run`.
  3. two rewrites then removal: preset `topicAttempts {key: 2}`, finish worse@[1]; ticks → op removed, log kind `remove`, then a better run → `applied` with one op.
  4. last topic: draft with one op, attempts 2, worse@[0] → `stopped`, `stopReason 'Все темы убраны — применять нечего'`, draft still `open`.
  5. unattributed worse: worse@[] → `noiseRetryUsed true`, step `start_run`; again worse@[] → `stopped`.
  6. run cap: preset `runsStarted 4`, step `start_run` → `stopped` with the 4-run message.
  7. failed run: mark run `failed` → `runFailures 1`, step `start_run`, `runsStarted` unchanged by this tick.
  8. cancel during await: set `status 'cancelled'`; finish run; tick → nothing changes, no new run row.
  9. resume: create a row directly at `await_run` with a done run; `drainAutopilots(deps)` → advances to `apply`.
  10. prepare tops up: zero case ids, `suggestCases` fake returns two cases → two `test_cases` rows with `origin 'suggested'`, `caseIds` length 2.
- [ ] **Step 2: Run** `npm --prefix server test -- draft-autopilot` (sandbox off) → FAIL.
- [ ] **Step 3: Implement `autopilot.ts`** following the spec's Engine section step by step. Check `test_cases.origin` for a check constraint or enum before inserting `'suggested'`; if one exists, extend it in migration 0046 (amend Task 1's migration only if it is not yet merged; otherwise add 0047).
- [ ] **Step 4: Run** → PASS. Fix until all ten pass.
- [ ] **Step 5: Routes tests.** `server/test/draft-autopilot-api.test.ts` using the same app builder as `draft-run-api.test.ts`:
  - POST creates a row at `prepare_cases`, answers the DTO; second POST → 409 `Черновик уже проверяется автоматически`.
  - POST on a draft without an OpenRouter key → 409 `Нет ключа OpenRouter`.
  - GET → latest row; GET on a draft with none → `null`.
  - cancel → `status 'cancelled'`.
  - While running: POST `/runs`, `/apply`, `/discard`, `/ops` → 409 `Черновик проверяется автоматически — остановите проверку, чтобы менять его вручную`.
  To keep the POST test from spending on a real turn, build the server with a fake model (as the run API test does) and assert only the immediate response and row.
- [ ] **Step 6: Implement routes** in `registerDraftRoutes`: `POST /api/agents/:agentId/drafts/:draftId/autopilot` (rate limit `{ max: 20, timeWindow: '1 minute' }`, body `{ caseIds: z.array(z.string()) }`, reject non-uuids with 404 `Случай не найден`, 409 when draft not open / `isDraftRunning` / a running row exists; insert; `setImmediate(() => void advanceAutopilot(ctx, id).catch(log))`), `GET …/autopilot`, `POST …/autopilot/cancel`. The unique partial index turns a race into a duplicate-key error: map `isDuplicate` to the same 409. Add the manual-route guard via one `assertNoAutopilot(draftId)` call at the top of the four manual handlers (after `loadDraft`).
- [ ] **Step 7: Drain timer** in `index.ts`, copying the CRM block's shape:

```ts
let autopilotRunning = false;
const autopilotDeps = { db, deps: liveDeps, key: credentialsKey(env), log: (o: object, m: string) => app.log.error(o, m), ops: defaultAutopilotOps };
const drainAutopilot = async () => {
  if (autopilotRunning) return;
  autopilotRunning = true;
  try { await drainAutopilots(autopilotDeps); }
  catch (error) { app.log.error({ error }, 'draft autopilot: drain failed'); }
  finally { autopilotRunning = false; }
};
const autopilotTimer = setInterval(() => void drainAutopilot(), 5_000);
autopilotTimer.unref();
```

Check the exact name of the `AiDeps` object passed to `registerDraftRoutes` in `buildServer` / `index.ts` and use that same object.
- [ ] **Step 8: Verify** `npm --prefix server test -- draft` (sandbox off) → all PASS; server typecheck.
- [ ] **Step 9: Commit** `feat(drafts): run a draft autopilot that fixes worse topics and applies`.

---

### Task 5: «Проверить и применить» on the draft screen

**Files:**
- Create: `rakurs/src/components/drafts/AutopilotPanel.tsx`, `rakurs/src/components/drafts/AutopilotPanel.test.tsx`
- Modify: `rakurs/src/api/index.ts` (next to `runDraft`, ~line 786)
- Modify: `rakurs/src/screens/DraftScreen.tsx`
- Modify: `rakurs/src/components/drafts/CaseList.tsx`, `OpDiff.tsx` only if a `disabled` prop is needed for checkboxes/edits
- Modify: `rakurs/src/screens/training-workspace.css` (panel styles, reuse existing tokens)

**Interfaces:**
- Consumes: `DraftAutopilot` (contract); API routes from Task 4.
- Produces:

```ts
export const startAutopilot = (agentId: string, draftId: string, caseIds: string[]) => request<DraftAutopilot>(…POST…);
export const getAutopilot = (agentId: string, draftId: string) => request<DraftAutopilot | null>(…GET…);
export const cancelAutopilot = (agentId: string, draftId: string) => request<DraftAutopilot>(…POST cancel…);
export function AutopilotPanel(props: { autopilot: DraftAutopilot; onCancel: () => void; cancelling: boolean }): JSX.Element;
export function autopilotHeadline(a: DraftAutopilot): string;
```

Copy the exact `request` call style `runDraft` uses.

`autopilotHeadline`:
- running + `prepare_cases` → `Идёт: подбираем проверки`
- running + `clean_topics` → `Идёт: чистим темы`
- running + `start_run`/`await_run` → `Идёт: прогон ${max(runsStarted,1)} из ${maxRuns}`
- running + `fix_topics` → `Идёт: исправляем темы`
- running + `apply` → `Идёт: применяем`
- applied → `Проверено и применено`
- stopped → `Остановлено: ${stopReason}`
- cancelled → `Проверка остановлена`

- [ ] **Step 1: Failing panel tests** (Testing Library, follow `OpDiff.test.tsx` setup):
  - headline for each status/step above (table-driven over `autopilotHeadline`);
  - renders log newest first, cost formatted like the run table's cost (reuse `cost.ts` formatter if one fits);
  - «Остановить» shown only when `running`, calls `onCancel`, disabled while `cancelling`.
- [ ] **Step 2: Run** `npm --prefix rakurs test -- AutopilotPanel` → FAIL.
- [ ] **Step 3: Implement** `AutopilotPanel` as a `Card` with `CardHead title="Автопроверка"`, headline line, a list (`kind` → colour: `fix` accent, `remove` danger, `warn` dim, `info` default), a spend line `Потрачено: …`, and the cancel button (`btn`).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Wire `DraftScreen`:**
  - Load `getAutopilot` on mount into state `autopilot`.
  - Poll it every 3 s while `autopilot?.status === 'running'` (copy the run polling effect's `alive`/`clearTimeout` pattern). On each poll: if `runId` changed, `setRun(await api.getDraftRun(...))` and `setRequestedCount`; refetch the draft (`api.getDraft`) and `setDraft`; `cases.reload()` when `caseIds` length changed.
  - On transition to `applied`: `toast.ok('Черновик проверен и применён')`, `navigate('../training?tab=review')`.
  - `autoRunning = autopilot?.status === 'running'`. Disable «Запустить прогон», «Применить», «Отбросить», topic edits (`onEdit` undefined) and case selection while `autoRunning`.
  - Action bar order: `btn-accent` «Проверить и применить» (text `Проверяем…` while `autoRunning` or starting; disabled when `!isOpen || running || autoRunning`), then `btn` «Запустить прогон», `btn` «Применить», `btn` «Отбросить».
  - Click: `setAutopilot(await api.startAutopilot(agentId, draftId, [...selected]))`; errors → `toast.fail`.
  - Render `<AutopilotPanel>` above the action bar card when `autopilot` is not null.
  - Hint when `selectedCases.length === 0` and not running: `Нажмите «Проверить и применить» — проверки подберутся сами, или отметьте случаи и запустите прогон вручную.`
- [ ] **Step 6: Verify** `npm --prefix rakurs test`, `npm --prefix rakurs run typecheck`, `npx vite build` in `rakurs/` → PASS.
- [ ] **Step 7: Commit** `feat(drafts): add one-click check-and-apply to the draft screen`.

---

## After all tasks

- Full `npm --prefix server test` (sandbox off) and `npm --prefix rakurs test`.
- `/code-review` on the branch diff, fix findings.
- Push, open a PR to `main` with the attribution line; releasing to production via `deploy/release.sh` needs the owner's yes.
