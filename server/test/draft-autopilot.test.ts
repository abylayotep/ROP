/**
 * The draft autopilot engine, one step per `advanceAutopilot` call. Runs are faked (a real
 * replay costs model calls) but land as real `test_runs`/`test_results` rows, so the attribution
 * read, `isDraftApplicable`, `applyDraft` and `editDraftOp` all run for real.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { TestRun } from '@rakurs/contract';
import type { Db } from '../src/db/client.js';
import {
  agents,
  draftAutopilots,
  kbDrafts,
  kbNotes,
  testCases,
  testResults,
  testRuns,
} from '../src/db/schema.js';
import { keyAad } from '../src/lib/ai/turn.js';
import { applyDraft } from '../src/lib/drafts/apply.js';
import {
  advanceAutopilot,
  drainAutopilots,
  type AutopilotDeps,
  type AutopilotOps,
} from '../src/lib/drafts/autopilot.js';
import { editDraftOp } from '../src/lib/drafts/edit-op.js';
import type { DraftOp } from '../src/lib/drafts/ops.js';
import { createAccountWithOwner } from '../src/lib/provision.js';
import { encryptSecret } from '../src/lib/secret-box.js';
import { withDb } from './helpers/db.js';
import { testEnv } from './helpers/env.js';
import { fakeGraph } from './helpers/fake-graph.js';
import { fakeLinked } from './helpers/fake-linked.js';
import { fakeModel } from './helpers/fake-model.js';

const env = testEnv();
const key = Buffer.from(env.CREDENTIALS_KEY, 'base64');

const OPS: Extract<DraftOp, { op: 'note_create' }>[] = [
  { op: 'note_create', path: 'Доставка', body: '## Факты\nДоставка по городу 1500 ₸.' },
  { op: 'note_create', path: 'Оплата', body: '## Факты\nОплата картой Kaspi.' },
];

let db: Db;
let agentId: string;
let userId: string;
let draftId: string;
let caseIds: string[];
let deps: AutopilotDeps;
let suggested: { title: string; messages: string[] }[];
let startRunCalls: number;
let onStartRun: (() => Promise<void>) | null;

async function openDraft(ops: DraftOp[]) {
  const [row] = await db
    .insert(kbDrafts)
    .values({ agentId, title: 'Черновик', origin: 'manual', status: 'open', ops, base: {} })
    .returning();
  return row!.id;
}

async function addCase(title: string) {
  const [row] = await db
    .insert(testCases)
    .values({ agentId, title, messages: [title], origin: 'manual' })
    .returning();
  return row!.id;
}

const fakeOps = (): AutopilotOps => ({
  async startRun(_ctx, input): Promise<TestRun> {
    startRunCalls += 1;
    if (onStartRun) await onStartRun();
    const [run] = await db
      .insert(testRuns)
      .values({
        agentId: input.agent.id,
        draftId: input.draft.id,
        configVersion: input.agent.configVersion,
        model: input.agent.model,
        status: 'running',
      })
      .returning();
    return {
      id: run!.id,
      draftId: input.draft.id,
      configVersion: run!.configVersion,
      model: run!.model,
      status: 'running',
      draftCost: '0',
      baselineCost: '0',
      results: [],
      startedAt: run!.startedAt.toISOString(),
      finishedAt: null,
    };
  },
  apply: applyDraft,
  editOp: editDraftOp,
  async cleanTopic(_deps, input) {
    return { body: input.body, reason: '', cost: '0.00100000' };
  },
  async rewriteTopic(_deps, input) {
    return { body: `${input.body} (исправлено)`, reason: 'убраны лишние строки', cost: '0.00200000' };
  },
  async suggestCases() {
    return { cases: suggested, cost: '0' };
  },
});

type Verdict = 'better' | 'worse' | 'same' | null;

async function finishRun(
  runId: string,
  results: { caseId: string; verdict: Verdict; usedOpIndexes: number[]; outcome?: string }[],
  cost = '0.01000000',
) {
  await db.update(testRuns).set({ status: 'done', cost, finishedAt: new Date() }).where(eq(testRuns.id, runId));
  for (const result of results) {
    await db.insert(testResults).values({
      runId,
      caseId: result.caseId,
      reply: 'стало',
      outcome: result.outcome ?? 'sent',
      verdict: result.verdict,
      verdictReason: result.verdict === null ? null : result.verdict === 'worse' ? 'ответ хуже' : 'ответ лучше',
      usedOpIndexes: result.usedOpIndexes,
    });
  }
}

async function createRow(values: Partial<typeof draftAutopilots.$inferInsert> = {}) {
  const [row] = await db
    .insert(draftAutopilots)
    .values({ agentId, draftId, createdBy: userId, status: 'running', step: 'prepare_cases', caseIds, ...values })
    .returning();
  return row!.id;
}

let id: string;
const tick = () => advanceAutopilot(deps, id);
const rowNow = async () => (await db.select().from(draftAutopilots).where(eq(draftAutopilots.id, id)))[0]!;
const draftNow = async () => (await db.select().from(kbDrafts).where(eq(kbDrafts.id, draftId)))[0]!;
const kinds = async () => (await rowNow()).log.map((entry) => entry.kind);
const runCount = async () => (await db.select().from(testRuns).where(eq(testRuns.draftId, draftId))).length;

beforeEach(async () => {
  db = await withDb();
  const owner = await createAccountWithOwner(db, {
    company: 'Сафина',
    email: 'owner@example.com',
    name: 'Владелец',
    initials: 'ВЛ',
    password: 'correct-horse-battery',
  });
  userId = owner.userId;
  agentId = randomUUID();
  await db.insert(agents).values({
    id: agentId,
    accountId: owner.accountId,
    name: 'Сафина',
    openrouterKey: encryptSecret('sk-or-v1-autopilot', key, keyAad(agentId)),
  });
  draftId = await openDraft(OPS);
  caseIds = [await addCase('Сколько стоит доставка?'), await addCase('Можно картой?')];
  suggested = [];
  startRunCalls = 0;
  onStartRun = null;
  deps = {
    db,
    deps: { model: fakeModel(), graph: fakeGraph(), linked: fakeLinked() },
    key,
    log: () => {},
    ops: fakeOps(),
  };
});

describe('advanceAutopilot', () => {
  it('prepares, cleans, runs and applies a draft with no worse case', async () => {
    id = await createRow();
    await tick();
    expect((await rowNow()).step).toBe('clean_topics');
    await tick();
    expect((await rowNow()).step).toBe('start_run');
    await tick();
    const running = await rowNow();
    expect(running).toMatchObject({ status: 'running', step: 'await_run', runsStarted: 1 });
    expect(running.runOps).toEqual(OPS);

    await tick();
    expect((await rowNow()).step).toBe('await_run');

    await finishRun(running.runId!, caseIds.map((caseId) => ({ caseId, verdict: 'better', usedOpIndexes: [0] })));
    await tick();
    expect((await rowNow()).step).toBe('apply');
    await tick();

    const done = await rowNow();
    expect(done.status).toBe('applied');
    expect(done.finishedAt).not.toBeNull();
    expect(done.log.map((entry) => entry.text)).toContain('Прогон 1 из 4');
    expect(done.log.at(-1)).toMatchObject({ kind: 'info', text: 'Применено' });
    // Two cleans at 0.001 plus the run's 0.01.
    expect(Number(done.cost)).toBeCloseTo(0.012, 8);
    expect((await draftNow()).status).toBe('applied');
    expect(await db.select().from(kbNotes).where(eq(kbNotes.agentId, agentId))).toHaveLength(2);
  });

  it('rewrites the topic a worse answer used, then reruns', async () => {
    id = await createRow({ step: 'start_run' });
    await tick();
    const { runId } = await rowNow();
    await finishRun(runId!, [
      { caseId: caseIds[0]!, verdict: 'better', usedOpIndexes: [0] },
      { caseId: caseIds[1]!, verdict: 'worse', usedOpIndexes: [1] },
    ]);

    await tick();
    const fixing = await rowNow();
    expect(fixing.step).toBe('fix_topics');
    expect(fixing.pendingFixes).toEqual([
      {
        key: 'path:Оплата',
        action: 'rewrite',
        cases: [{ title: 'Можно картой?', messages: ['Можно картой?'], before: null, after: 'стало', reason: 'ответ хуже' }],
      },
    ]);

    await tick();
    const fixed = await rowNow();
    expect(fixed.step).toBe('start_run');
    expect(fixed.pendingFixes).toBeNull();
    expect(fixed.topicAttempts['path:Оплата']).toBe(1);
    expect(fixed.log.at(-1)).toMatchObject({
      kind: 'fix',
      text: 'Переписана тема „Оплата“: убраны лишние строки',
    });
    const draft = await draftNow();
    expect((draft.ops[1] as { body: string }).body.endsWith('(исправлено)')).toBe(true);
    expect((draft.ops[0] as { body: string }).body).toBe(OPS[0]!.body);
  });

  it('removes a topic still worse after two rewrites and applies the rest', async () => {
    id = await createRow({ step: 'start_run', topicAttempts: { 'path:Оплата': 2 } });
    await tick();
    await finishRun((await rowNow()).runId!, [
      { caseId: caseIds[0]!, verdict: 'better', usedOpIndexes: [0] },
      { caseId: caseIds[1]!, verdict: 'worse', usedOpIndexes: [0, 1] },
    ]);
    await tick();
    const fixing = await rowNow();
    expect(fixing.pendingFixes!.map((fix) => [fix.key, fix.action])).toEqual([
      ['path:Доставка', 'rewrite'],
      ['path:Оплата', 'remove'],
    ]);

    await tick();
    const fixed = await rowNow();
    expect(fixed.step).toBe('start_run');
    expect(await kinds()).toContain('remove');
    expect(fixed.log.at(-1)).toMatchObject({
      kind: 'remove',
      text: 'Убрана тема „Оплата“: после двух попыток исправления ответ всё ещё хуже',
    });
    expect((await draftNow()).ops.map((op) => (op as { path: string }).path)).toEqual(['Доставка']);

    await tick();
    const rerun = await rowNow();
    expect(rerun).toMatchObject({ step: 'await_run', runsStarted: 2 });
    expect(rerun.runOps).toHaveLength(1);
    await finishRun(rerun.runId!, caseIds.map((caseId) => ({ caseId, verdict: 'better', usedOpIndexes: [0] })));
    await tick();
    await tick();
    expect((await rowNow()).status).toBe('applied');
    const draft = await draftNow();
    expect(draft.status).toBe('applied');
    expect(draft.ops).toHaveLength(1);
  });

  it('stops without discarding when the last topic would be removed', async () => {
    const onlyOp: DraftOp[] = [OPS[0]!];
    await db.update(kbDrafts).set({ ops: onlyOp }).where(eq(kbDrafts.id, draftId));
    id = await createRow({ step: 'start_run', topicAttempts: { 'path:Доставка': 2 } });
    await tick();
    await finishRun((await rowNow()).runId!, [{ caseId: caseIds[0]!, verdict: 'worse', usedOpIndexes: [0] }]);
    await tick();
    expect((await rowNow()).step).toBe('fix_topics');
    await tick();

    const stopped = await rowNow();
    expect(stopped.status).toBe('stopped');
    expect(stopped.stopReason).toBe('Все темы убраны — применять нечего');
    expect(stopped.log.at(-1)).toMatchObject({ kind: 'warn', text: 'Все темы убраны — применять нечего' });
    const draft = await draftNow();
    expect(draft.status).toBe('open');
    expect(draft.ops).toEqual(onlyOp);
  });

  it('retries once when a worse answer used no draft topic, then stops', async () => {
    id = await createRow({ step: 'start_run' });
    await tick();
    await finishRun((await rowNow()).runId!, [
      { caseId: caseIds[0]!, verdict: 'better', usedOpIndexes: [0] },
      { caseId: caseIds[1]!, verdict: 'worse', usedOpIndexes: [] },
    ]);
    await tick();
    const retrying = await rowNow();
    expect(retrying).toMatchObject({ status: 'running', step: 'start_run', noiseRetryUsed: true });
    expect(retrying.log.at(-1)).toMatchObject({
      kind: 'warn',
      text: 'Случай „Можно картой?“ хуже, но темы черновика в ответе не участвовали — перепроверяем',
    });

    await tick();
    await finishRun((await rowNow()).runId!, [{ caseId: caseIds[1]!, verdict: 'worse', usedOpIndexes: [] }]);
    await tick();
    const stopped = await rowNow();
    expect(stopped.status).toBe('stopped');
    expect(stopped.stopReason).toBe('Случай „Можно картой?“ стал хуже не из-за тем черновика — проверьте его вручную');
    expect((await draftNow()).status).toBe('open');
  });

  it('never applies a run the judge could not score: retries once, then stops', async () => {
    id = await createRow({ step: 'start_run' });
    await tick();
    await finishRun((await rowNow()).runId!, caseIds.map((caseId) => ({ caseId, verdict: null, usedOpIndexes: [0] })));
    await tick();
    const retrying = await rowNow();
    expect(retrying).toMatchObject({ status: 'running', step: 'start_run', noiseRetryUsed: true, pendingFixes: null });
    expect(retrying.log.at(-1)).toMatchObject({
      kind: 'warn',
      // Result rows come back in no set order; either case may be named.
      text: expect.stringMatching(/^Случай „(Сколько стоит доставка\?|Можно картой\?)“ не удалось оценить — перепроверяем$/),
    });

    await tick();
    await finishRun((await rowNow()).runId!, caseIds.map((caseId) => ({ caseId, verdict: null, usedOpIndexes: [0] })));
    await tick();
    const stopped = await rowNow();
    expect(stopped.status).toBe('stopped');
    expect(stopped.stopReason)
      .toMatch(/^Случай „(Сколько стоит доставка\?|Можно картой\?)“ не удалось оценить — проверьте его вручную$/);
    expect((await draftNow()).status).toBe('open');
  });

  it('never applies a run whose draft-side turn failed: retries once, then stops', async () => {
    id = await createRow({ step: 'start_run' });
    await tick();
    await finishRun((await rowNow()).runId!, [
      { caseId: caseIds[0]!, verdict: 'better', usedOpIndexes: [0] },
      { caseId: caseIds[1]!, verdict: 'same', usedOpIndexes: [1], outcome: 'failed' },
    ]);
    await tick();
    const retrying = await rowNow();
    expect(retrying).toMatchObject({ status: 'running', step: 'start_run', noiseRetryUsed: true });
    expect(retrying.log.at(-1)).toMatchObject({ kind: 'warn', text: 'Случай „Можно картой?“ не удалось оценить — перепроверяем' });

    await tick();
    await finishRun((await rowNow()).runId!, [{ caseId: caseIds[1]!, verdict: 'better', usedOpIndexes: [1], outcome: 'failed' }]);
    await tick();
    const stopped = await rowNow();
    expect(stopped.status).toBe('stopped');
    expect(stopped.stopReason).toBe('Случай „Можно картой?“ не удалось оценить — проверьте его вручную');
    expect((await draftNow()).status).toBe('open');
  });

  it('still attributes a worse verdict whose turn failed to the topics it used', async () => {
    id = await createRow({ step: 'start_run' });
    await tick();
    await finishRun((await rowNow()).runId!, [
      { caseId: caseIds[0]!, verdict: 'better', usedOpIndexes: [0] },
      { caseId: caseIds[1]!, verdict: 'worse', usedOpIndexes: [1], outcome: 'failed' },
    ]);
    await tick();
    const row = await rowNow();
    expect(row.step).toBe('fix_topics');
    expect(row.pendingFixes!.map((fix) => fix.key)).toEqual(['path:Оплата']);
  });

  it('stops once four runs are used', async () => {
    id = await createRow({ step: 'start_run', runsStarted: 4 });
    await tick();
    const stopped = await rowNow();
    expect(stopped).toMatchObject({ status: 'stopped', step: 'start_run' });
    expect(stopped.stopReason).toBe('Не удалось добиться результата за 4 прогона');
    expect(await kinds()).toEqual(['warn']);
    expect(startRunCalls).toBe(0);
  });

  it('restarts a failed run and counts the failure', async () => {
    id = await createRow({ step: 'start_run' });
    await tick();
    const { runId } = await rowNow();
    await db.update(testRuns).set({ status: 'failed' }).where(eq(testRuns.id, runId!));
    await tick();
    const restarted = await rowNow();
    expect(restarted).toMatchObject({ status: 'running', step: 'start_run', runFailures: 1, runsStarted: 1 });
    expect(await kinds()).toContain('warn');
  });

  it('keeps the spend of a failed run and its paired baseline', async () => {
    id = await createRow({ step: 'start_run', cost: '0.00100000' });
    await tick();
    const { runId } = await rowNow();
    await db.insert(testRuns)
      .values({ agentId, draftId: null, configVersion: 1, model: 'openai/gpt-4o-mini', status: 'done', cost: '0.00500000' });
    await db.update(testRuns).set({ status: 'failed', cost: '0.02000000' }).where(eq(testRuns.id, runId!));
    await tick();
    const restarted = await rowNow();
    expect(restarted).toMatchObject({ step: 'start_run', runFailures: 1 });
    expect(Number(restarted.cost)).toBeCloseTo(0.026, 8);

    // The third failure stops the autopilot and still counts what that run spent.
    await db.update(draftAutopilots).set({ runFailures: 2 }).where(eq(draftAutopilots.id, id));
    await tick();
    const second = await rowNow();
    await db.update(testRuns).set({ status: 'failed', cost: '0.03000000' }).where(eq(testRuns.id, second.runId!));
    await tick();
    const stopped = await rowNow();
    expect(stopped.status).toBe('stopped');
    expect(Number(stopped.cost)).toBeCloseTo(0.056, 8);
  });

  it('stops after the third failed run', async () => {
    id = await createRow({ step: 'await_run', runFailures: 2, runsStarted: 3, runId: null });
    await tick();
    const stopped = await rowNow();
    expect(stopped.status).toBe('stopped');
    expect(stopped.stopReason).toBe('Прогон трижды оборвался');
  });

  it('does nothing more once cancelled while a run is in flight', async () => {
    id = await createRow({ step: 'start_run' });
    await tick();
    const before = await rowNow();
    await db.update(draftAutopilots).set({ status: 'cancelled' }).where(eq(draftAutopilots.id, id));
    await finishRun(before.runId!, caseIds.map((caseId) => ({ caseId, verdict: 'better', usedOpIndexes: [0] })));
    await tick();
    await tick();
    const after = await rowNow();
    expect(after).toMatchObject({ status: 'cancelled', step: 'await_run', runsStarted: 1 });
    expect(after.log).toEqual(before.log);
    expect(await runCount()).toBe(1);
    expect((await draftNow()).status).toBe('open');
  });

  it('drops a step whose cancel landed while the step was running', async () => {
    id = await createRow({ step: 'start_run' });
    onStartRun = async () => {
      await db.update(draftAutopilots).set({ status: 'cancelled' }).where(eq(draftAutopilots.id, id));
    };
    await tick();
    expect(await rowNow()).toMatchObject({ status: 'cancelled', step: 'start_run', runsStarted: 0, runId: null });
  });

  it('starts no run when the cancel lands after the row was loaded', async () => {
    id = await createRow({ step: 'start_run' });
    // Cancels the moment the engine has read the agent — after its own status check on load,
    // before the step's side effect.
    const cancel = () => db.update(draftAutopilots).set({ status: 'cancelled' }).where(eq(draftAutopilots.id, id));
    deps.db = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== 'select') return Reflect.get(target, prop, receiver);
        return (...args: unknown[]) => {
          const builder = (target.select as (...a: unknown[]) => { from: (t: unknown) => unknown })(...args);
          return new Proxy(builder, {
            get(b, bprop, breceiver) {
              if (bprop !== 'from') return Reflect.get(b, bprop, breceiver);
              return (table: unknown) => {
                const query = b.from(table) as { where: (...w: unknown[]) => Promise<unknown> };
                if (table !== agents) return query;
                return { where: (...w: unknown[]) => query.where(...w).then(async (rows) => { await cancel(); return rows; }) };
              };
            },
          });
        };
      },
    });
    await tick();
    expect(startRunCalls).toBe(0);
    expect(await runCount()).toBe(0);
    expect(await rowNow()).toMatchObject({ status: 'cancelled', step: 'start_run' });
  });

  it('makes no further topic edit once cancelled between two edits', async () => {
    id = await createRow({ step: 'clean_topics' });
    deps.ops.cleanTopic = async (_d, input) => ({ body: `${input.body}\nЧище.`, reason: 'убран диалог', cost: '0' });
    let edits = 0;
    deps.ops.editOp = async (database, input) => {
      edits += 1;
      const updated = await editDraftOp(database, input);
      await db.update(draftAutopilots).set({ status: 'cancelled' }).where(eq(draftAutopilots.id, id));
      return updated;
    };
    await tick();
    expect(edits).toBe(1);
    const draft = await draftNow();
    expect((draft.ops[0] as { body: string }).body).toBe(`${OPS[0]!.body}\nЧище.`);
    expect((draft.ops[1] as { body: string }).body).toBe(OPS[1]!.body);
    expect(await rowNow()).toMatchObject({ status: 'cancelled', step: 'clean_topics' });
  });

  it('waits on a done run until its paired baseline run is done too', async () => {
    id = await createRow({ step: 'start_run' });
    await tick();
    const { runId } = await rowNow();
    const [baseline] = await db
      .insert(testRuns)
      .values({ agentId, draftId: null, configVersion: 1, model: 'openai/gpt-4o-mini', status: 'running' })
      .returning();
    await finishRun(runId!, caseIds.map((caseId) => ({ caseId, verdict: 'better', usedOpIndexes: [0] })));
    await tick();
    expect((await rowNow()).step).toBe('await_run');

    await db.update(testRuns).set({ status: 'done', cost: '0.00500000' }).where(eq(testRuns.id, baseline!.id));
    await tick();
    const row = await rowNow();
    expect(row.step).toBe('apply');
    expect(Number(row.cost)).toBeCloseTo(0.015, 8);
  });

  it('keeps the required correction case when the owner picked twenty cases', async () => {
    const [required] = await db
      .insert(testCases)
      .values({ agentId, title: 'Исправление', messages: ['Сколько?'], origin: 'correction', requiredDraftId: draftId })
      .returning();
    const many: string[] = [];
    for (let i = 0; i < 20; i += 1) many.push(await addCase(`Вопрос ${i}`));
    id = await createRow({ caseIds: many });
    await tick();
    const row = await rowNow();
    expect(row.step).toBe('clean_topics');
    expect(row.caseIds).toHaveLength(20);
    expect(row.caseIds[0]).toBe(required!.id);
  });

  it('resumes a row left at await_run on the next drain', async () => {
    const [run] = await db
      .insert(testRuns)
      .values({ agentId, draftId, configVersion: 1, model: 'openai/gpt-4o-mini', status: 'running' })
      .returning();
    await finishRun(run!.id, caseIds.map((caseId) => ({ caseId, verdict: 'better', usedOpIndexes: [1] })));
    id = await createRow({ step: 'await_run', runId: run!.id, runOps: OPS, runsStarted: 1 });

    await drainAutopilots(deps);
    expect(await rowNow()).toMatchObject({ status: 'running', step: 'apply' });
  });

  it('tops the cases up with saved suggestions when there are fewer cases than topics', async () => {
    suggested = [
      { title: 'Доставка в область', messages: ['А в область везёте?'] },
      { title: 'Рассрочка', messages: ['Есть рассрочка?'] },
      { title: 'Лишний', messages: ['Лишний вопрос'] },
    ];
    id = await createRow({ caseIds: [] });
    await tick();

    const row = await rowNow();
    expect(row.step).toBe('clean_topics');
    expect(row.caseIds).toHaveLength(2);
    const saved = await db
      .select()
      .from(testCases)
      .where(and(eq(testCases.agentId, agentId), eq(testCases.origin, 'suggested')));
    expect(saved.map((c) => c.title).sort()).toEqual(['Доставка в область', 'Рассрочка']);
    expect(new Set(row.caseIds)).toEqual(new Set(saved.map((c) => c.id)));
    expect(row.log.at(-1)).toMatchObject({ kind: 'info', text: 'Добавлено 2 проверок' });
  });

  it('keeps only enabled cases and stops when none are left', async () => {
    await db.update(testCases).set({ enabled: false }).where(eq(testCases.agentId, agentId));
    await db.update(kbDrafts).set({ ops: [{ op: 'rule_create', category: 'forbid', text: 'Не обещай скидку.' }] })
      .where(eq(kbDrafts.id, draftId));
    id = await createRow();
    await tick();
    const stopped = await rowNow();
    expect(stopped.status).toBe('stopped');
    expect(stopped.stopReason).toBe('Не из чего собрать проверки');
  });

  it('counts a required correction case that is not better as bad', async () => {
    const [required] = await db
      .insert(testCases)
      .values({ agentId, title: 'Исправление', messages: ['Сколько?'], origin: 'correction', requiredDraftId: draftId })
      .returning();
    id = await createRow({ caseIds: [caseIds[0]!] });
    await tick();
    expect((await rowNow()).caseIds).toEqual([required!.id, caseIds[0]]);
    await tick();
    await tick();
    await finishRun((await rowNow()).runId!, [
      { caseId: caseIds[0]!, verdict: 'better', usedOpIndexes: [0] },
      { caseId: required!.id, verdict: 'same', usedOpIndexes: [0] },
    ]);
    await tick();
    const row = await rowNow();
    expect(row.step).toBe('fix_topics');
    expect(row.pendingFixes).toEqual([
      expect.objectContaining({ key: 'path:Доставка', action: 'rewrite' }),
    ]);
  });

  it('stops before any step when the draft is no longer open or the key is gone', async () => {
    id = await createRow({ step: 'start_run' });
    await db.update(kbDrafts).set({ status: 'discarded' }).where(eq(kbDrafts.id, draftId));
    await tick();
    expect(await rowNow()).toMatchObject({ status: 'stopped', stopReason: 'Черновик уже применён или отброшен' });

    await db.update(kbDrafts).set({ status: 'open' }).where(eq(kbDrafts.id, draftId));
    await db.update(agents).set({ openrouterKey: null }).where(eq(agents.id, agentId));
    id = await createRow({ step: 'start_run' });
    await tick();
    expect(await rowNow()).toMatchObject({ status: 'stopped', stopReason: 'Нет ключа OpenRouter' });
    expect(startRunCalls).toBe(0);
  });

  it('stays on start_run while turn slots are busy and stops on any other refusal', async () => {
    const { ApiError } = await import('../src/lib/errors.js');
    id = await createRow({ step: 'start_run' });
    deps.ops.startRun = async () => {
      throw new ApiError(429, 'Прогоны заняты. Попробуйте через несколько секунд.');
    };
    await tick();
    expect(await rowNow()).toMatchObject({ status: 'running', step: 'start_run', runsStarted: 0 });

    deps.ops.startRun = async () => {
      throw new ApiError(409, 'Сначала подключите номер WhatsApp — агенту некуда отвечать');
    };
    await tick();
    expect(await rowNow()).toMatchObject({
      status: 'stopped',
      stopReason: 'Сначала подключите номер WhatsApp — агенту некуда отвечать',
    });
  });

  it('keeps only the newest fifty log entries', async () => {
    const old = Array.from({ length: 50 }, (_, i) => ({ at: new Date(0).toISOString(), kind: 'info' as const, text: `старое ${i}` }));
    id = await createRow({ step: 'start_run', log: old });
    await tick();
    const { log } = await rowNow();
    expect(log).toHaveLength(50);
    expect(log[0]!.text).toBe('старое 1');
    expect(log.at(-1)!.text).toBe('Прогон 1 из 4');
  });

  it('stops with an internal error when a step throws something unexpected', async () => {
    id = await createRow({ step: 'start_run' });
    deps.ops.startRun = async () => {
      throw new Error('boom');
    };
    await tick();
    expect(await rowNow()).toMatchObject({ status: 'stopped', stopReason: 'Внутренняя ошибка — попробуйте ещё раз' });
  });

  it('keeps the original body and logs a warning when a clean-up call fails', async () => {
    id = await createRow({ step: 'clean_topics' });
    const { TopicFixError } = await import('../src/lib/drafts/topic-fix.js');
    deps.ops.cleanTopic = async (_d, input) => {
      if (input.title === 'Доставка') throw new TopicFixError('invented_number', '0.00300000');
      return { body: `${input.body}\nЧище.`, reason: 'убран диалог', cost: '0.00100000' };
    };
    await tick();
    const row = await rowNow();
    expect(row.step).toBe('start_run');
    expect(row.log.map((entry) => entry.kind)).toEqual(['warn', 'fix']);
    expect(row.log[1]!.text).toBe('Почищена тема „Оплата“: убран диалог');
    expect(Number(row.cost)).toBeCloseTo(0.004, 8);
    const draft = await draftNow();
    expect((draft.ops[0] as { body: string }).body).toBe(OPS[0]!.body);
    expect((draft.ops[1] as { body: string }).body).toBe(`${OPS[1]!.body}\nЧище.`);
  });
});
