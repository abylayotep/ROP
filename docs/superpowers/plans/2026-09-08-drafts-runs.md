# Drafts and Test Runs — Part 2: replaying and running

> Part of [the drafts plan](2026-09-08-drafts-and-test-runs.md). Read its header and **Global Constraints** before starting, and use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to work through the tasks. Steps use checkbox (`- [ ]`) syntax.

**Spec:** [docs/superpowers/specs/2026-09-08-drafts-and-test-runs-design.md](../specs/2026-09-08-drafts-and-test-runs-design.md)

---

### Task 4: Replaying a case

**Files:**
- Create: `server/src/lib/drafts/replay.ts`
- Modify: `server/src/api/ai.ts` (export the sandbox conversation builder instead of keeping it private)
- Test: `server/test/draft-replay.test.ts`

**Interfaces:**
- Consumes: `runTurn`, `applyOps`, and the transaction-and-throw pattern in `server/src/api/ai.ts:155-243`.
- Produces: `export async function replayCase(db: Db, deps: AiDeps, input: ReplayInput): Promise<ReplayResult>` where `ReplayInput = { agentId: string; numberId: string; key: Buffer; messages: string[]; ops: DraftOp[] }` and `ReplayResult = { reply: string | null; usedChunkIds: string[]; stageId: string | null; handoff: boolean; handoffReason: string | null; outcome: TurnOutcome; cost: string }`.

- [ ] **Step 1: Write the failing test**

```ts
// server/test/draft-replay.test.ts
it('answers from the draft rather than from the store', async () => {
  model.reply({ text: 'Доставка 1600 ₸.' });
  const result = await replayCase(db, deps, { agentId, numberId, key,
    messages: ['сколько стоит доставка'],
    ops: [{ op: 'note_create', path: 'Доставка', body: '1600 ₸.' }] });
  expect(result.outcome).not.toBe('failed');
  expect(model.lastMessages.some((m) => m.content.includes('1600 ₸.'))).toBe(true);
});

it('leaves the store exactly as it found it', async () => {
  const before = await snapshot(db, agentId);
  await replayCase(db, deps, { agentId, numberId, key, messages: ['здравствуйте'],
    ops: [{ op: 'note_create', path: 'Доставка', body: '1600 ₸.' }] });
  expect(await snapshot(db, agentId)).toEqual(before);
});

it('carries the conversation forward across messages', async () => {
  model.reply({ text: 'Какие двери нужны?' });
  model.reply({ text: 'Входные — от 80 000 ₸.' });
  await replayCase(db, deps, { agentId, numberId, key,
    messages: ['здравствуйте', 'входные'], ops: [] });
  const second = model.callsAt(1)!.messages.map((m) => m.content).join('\n');
  expect(second).toContain('Какие двери нужны?');
});

it('reports the sections the reply was built from', async () => {
  model.reply({ text: 'Доставка 1600 ₸.' });
  const result = await replayCase(db, deps, { agentId, numberId, key,
    messages: ['сколько стоит доставка'],
    ops: [{ op: 'note_create', path: 'Доставка', body: '## По городу\n1600 ₸.' }] });
  expect(result.usedChunkIds).toHaveLength(1);
});

it('reports a handoff and its reason instead of a reply', async () => {
  model.reply({ text: 'Скидка 90%.' });
  const result = await replayCase(db, deps, { agentId, numberId, key,
    messages: ['дадите скидку?'], ops: [] });
  expect(result.handoff).toBe(true);
  expect(result.handoffReason).toContain('90');
  expect(result.reply).toBeNull();
});
```

`snapshot` is a helper in the test file reading every note, chunk, link, rule, contact,
conversation and message of the agent into one comparable object.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/draft-replay.test.ts`
Expected: FAIL — unresolved import.

- [ ] **Step 3: Write `replay.ts`**

Lift the private `SandboxDone` class and the contact-conversation-message setup out of
`server/src/api/ai.ts` into `replay.ts`, and have the sandbox route call the new function with
one message and no ops. The comments on `SandboxDone` and on the transaction move with the code
— they explain why a throw is both the rollback and the return, and they are the reason nobody
reaches for a `finally` that deletes.

Then: open the transaction, `applyOps`, insert the contact and the conversation, and for each
message in turn insert it and call `runTurn` with `dryRun: true`, inserting the reply the turn
produced as an outbound message so the next turn reads it as history. Keep the result of the
last turn, throw `SandboxDone`, and return it from the catch.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/draft-replay.test.ts test/ai-sandbox.test.ts`
Expected: PASS — the second file proving the sandbox route still behaves after the lift.

- [ ] **Step 5: Commit**

```bash
git add server/src server/test/draft-replay.test.ts
git commit -m "Replay a conversation against a draft and keep nothing"
```

---

### Task 5: The baseline

**Files:**
- Create: `server/src/lib/drafts/baseline.ts`
- Test: `server/test/draft-baseline.test.ts`

**Interfaces:**
- Produces: `export async function baselineResults(db: Db, agentId: string, caseIds: string[], configVersion: number, model: string): Promise<Map<string, typeof testResults.$inferSelect>>` — the newest baseline result per case at that version and model, and nothing for the cases that have none.

- [ ] **Step 1: Write the failing test**

```ts
// server/test/draft-baseline.test.ts
it('reuses a baseline at the same version and model', async () => {
  const kase = await addCase('сколько стоит доставка');
  await recordBaseline(kase.id, { version: 3, model: 'openai/gpt-4o-mini', reply: '1500 ₸.' });
  const found = await baselineResults(db, agentId, [kase.id], 3, 'openai/gpt-4o-mini');
  expect(found.get(kase.id)!.reply).toBe('1500 ₸.');
});

it('does not reuse a baseline from an older version', async () => {
  const kase = await addCase('сколько стоит доставка');
  await recordBaseline(kase.id, { version: 3, model: 'openai/gpt-4o-mini', reply: '1500 ₸.' });
  expect((await baselineResults(db, agentId, [kase.id], 4, 'openai/gpt-4o-mini')).size).toBe(0);
});

it('does not reuse a baseline from another model', async () => {
  const kase = await addCase('сколько стоит доставка');
  await recordBaseline(kase.id, { version: 3, model: 'openai/gpt-4o-mini', reply: '1500 ₸.' });
  expect((await baselineResults(db, agentId, [kase.id], 3, 'google/gemini-2.5-flash')).size).toBe(0);
});

it('takes the newest baseline when there are several', async () => {
  const kase = await addCase('сколько стоит доставка');
  await recordBaseline(kase.id, { version: 3, model: 'openai/gpt-4o-mini', reply: 'старый' });
  await recordBaseline(kase.id, { version: 3, model: 'openai/gpt-4o-mini', reply: 'новый' });
  const found = await baselineResults(db, agentId, [kase.id], 3, 'openai/gpt-4o-mini');
  expect(found.get(kase.id)!.reply).toBe('новый');
});

it('returns nothing for a case that has never been run', async () => {
  const kase = await addCase('есть ли рассрочка');
  expect((await baselineResults(db, agentId, [kase.id], 1, 'openai/gpt-4o-mini')).size).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/draft-baseline.test.ts`
Expected: FAIL — unresolved import.

- [ ] **Step 3: Write `baseline.ts`**

One query: join `test_results` to `test_runs`, filter to `draftId is null`, this agent, this
`configVersion` and this `model`, and take the newest row per `caseId`. The comment on it says
what the reuse buys and when it is wrong to reuse — a version or a model that moved is a
different agent answering, and comparing against it would compare two changes at once.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/draft-baseline.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/lib/drafts/baseline.ts server/test/draft-baseline.test.ts
git commit -m "Reuse what the agent answered before the draft"
```

---

### Task 6: The run route

**Files:**
- Create: `server/src/api/drafts.ts`
- Modify: `server/src/api/server.ts` (register)
- Test: `server/test/draft-run-api.test.ts`

**Interfaces:**
- Consumes: `replayCase`, `baselineResults`, `applyOps`, the sandbox's in-flight counter.
- Produces: `POST /api/agents/:agentId/drafts`, `GET /api/agents/:agentId/drafts/:draftId`, `POST /api/agents/:agentId/drafts/:draftId/runs`, `GET …/runs/:runId`, and `POST /api/agents/:agentId/coach/messages/:id/draft` — the route the coaching plan left unwritten.

- [ ] **Step 1: Write the failing test**

```ts
// server/test/draft-run-api.test.ts
it('turns a coach proposal into a draft holding one operation', async () => {
  const message = await coachProposed({ kind: 'rule', category: 'forbid', text: 'Не обещай скидку.' });
  const res = await app.inject({ method: 'POST', cookies: jar,
    url: `/api/agents/${agentId}/coach/messages/${message.id}/draft` });
  expect(res.json().ops).toEqual([{ op: 'rule_create', category: 'forbid', text: 'Не обещай скидку.' }]);
  const [stored] = await db.select().from(coachMessages).where(eq(coachMessages.id, message.id));
  expect(stored!.status).toBe('drafted');
});

it('runs every named case and records a result each', async () => {
  const draft = await openDraft();
  const one = await addCase('сколько стоит доставка');
  const two = await addCase('есть ли рассрочка');
  model.replyAlways({ text: 'Уточню у коллеги.' });
  const res = await app.inject({ method: 'POST', cookies: jar,
    url: `${drafts()}/${draft.id}/runs`, payload: { caseIds: [one.id, two.id] } });
  expect(res.json().results).toHaveLength(2);
  expect(res.json().results[0]!.before).not.toBeNull();
});

it('spends nothing on a baseline it already has', async () => {
  const draft = await openDraft();
  const kase = await addCase('сколько стоит доставка');
  model.replyAlways({ text: 'Уточню у коллеги.' });
  await run(draft.id, [kase.id]);
  const spent = model.calls.length;
  const second = await openDraft();
  await run(second.id, [kase.id]);
  // One call for the draft side. The baseline is read, not re-run.
  expect(model.calls.length).toBe(spent + 1);
});

it('refuses more than twenty cases', async () => {
  const draft = await openDraft();
  const ids = await Promise.all(Array.from({ length: 21 }, (_, i) => addCase(`вопрос ${i}`)));
  const res = await app.inject({ method: 'POST', cookies: jar,
    url: `${drafts()}/${draft.id}/runs`, payload: { caseIds: ids.map((c) => c.id) } });
  expect(res.statusCode).toBe(400);
  expect(res.json().message).toBe('За один прогон можно проверить не больше двадцати случаев');
});

it('refuses a fourth run in flight with 429', async () => {
  model.hang();
  const draft = await openDraft();
  const kase = await addCase('сколько стоит доставка');
  const inFlight = [run(draft.id, [kase.id]), run(draft.id, [kase.id]), run(draft.id, [kase.id])];
  expect((await run(draft.id, [kase.id])).statusCode).toBe(429);
  model.release();
  await Promise.all(inFlight);
});

it('refuses a member', async () => {
  const draft = await openDraft();
  const res = await app.inject({ method: 'POST', cookies: memberJar,
    url: `${drafts()}/${draft.id}/runs`, payload: { caseIds: [] } });
  expect(res.statusCode).toBe(403);
});

it('leaves the store untouched by a run', async () => {
  const draft = await openDraft([{ op: 'rule_create', category: 'forbid', text: 'Не обещай скидку.' }]);
  const kase = await addCase('дадите скидку?');
  model.replyAlways({ text: 'Уточню у коллеги.' });
  const before = await snapshot(db, agentId);
  await run(draft.id, [kase.id]);
  expect(await snapshot(db, agentId)).toEqual(before);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/draft-run-api.test.ts`
Expected: FAIL — 404 on the draft routes.

- [ ] **Step 3: Write the routes**

`POST /coach/messages/:id/draft` maps the stored `CoachProposal` onto one `DraftOp`, takes
`baseOf`, writes the draft, and sets the coach message to `drafted` with its `draftId`.

`POST /drafts/:draftId/runs` validates at most 20 case ids, opens a `test_runs` row at the
agent's current `configVersion` and model, fetches the baselines it can reuse, and for each case
runs the draft side with `replayCase` and — only where no baseline exists — the baseline side
with the same function and empty ops. Results are written per case; the run's cost is the sum.
The response pairs `before` and `after` per case.

Cost is summed from what the client reports, and a model that reports none records zero, not
null — the rule `ai_replies` already follows.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/draft-run-api.test.ts` then `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/api server/test/draft-run-api.test.ts
git commit -m "Run a draft over a set of conversations"
```
