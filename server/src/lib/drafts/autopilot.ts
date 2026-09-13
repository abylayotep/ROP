/**
 * The draft autopilot: one button that picks cases, cleans topics, runs the draft, rewrites or
 * removes the topics that made answers worse, reruns, and applies.
 *
 * The `draft_autopilots` row is the whole state. Each `advanceAutopilot` call loads the row, the
 * draft and the agent fresh, performs exactly one step and writes the next `step` in the same
 * update, so a restart (or a closed page) resumes where the row says. `index.ts` drains running
 * rows every few seconds; a step that has nothing to do yet (a run still in flight, no free turn
 * slot) writes nothing and is simply tried again on the next tick.
 *
 * Every write is guarded by `status = 'running'`: an owner's cancel that lands while a step is
 * working wins, and that step's result is dropped. The engine calls the same lib functions the
 * manual routes do, so it is never blocked by the routes' "autopilot is running" guard.
 */
import type { AutopilotStep, DraftAutopilot, TestRun } from '@rakurs/contract';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { agents, draftAutopilots, kbDrafts, testCases, testRuns } from '../../db/schema.js';
import { addCost, keyAad } from '../ai/turn.js';
import { ApiError } from '../errors.js';
import { clampTitle } from '../knowledge/split.js';
import { decryptSecret } from '../secret-box.js';
import { isDraftApplicable } from './applicable.js';
import { applyDraft } from './apply.js';
import type { AutopilotLogEntry, AutopilotLogKind, FailingCase, PendingFix } from './autopilot-types.js';
import { editDraftOp, opTitle, topicKey } from './edit-op.js';
import type { DraftOp } from './ops.js';
import { isDraftRunning, MAX_CASES, startDraftRun, type RunAgent, type RunContext } from './run.js';
import { pairedBaselineRun, readRun } from './run-read.js';
import { suggestCases } from './suggest.js';
import { cleanTopic, rewriteTopic, TopicFixError, type TopicFixDeps } from './topic-fix.js';

export const AUTOPILOT_MAX_RUNS = 4;
export const AUTOPILOT_MAX_REWRITES = 2;
export const AUTOPILOT_MAX_RUN_FAILURES = 3;
const LOG_MAX = 50;
/** The bounds `api/test-cases.ts` puts on a case the owner saves by hand. */
const CASE_TITLE_MAX = 200;
const CASE_MESSAGES_MAX = 10;
const CASE_MESSAGE_MAX = 4000;
/** Outcomes that count as the agent actually answering — the same list `isDraftApplicable` uses. */
const ANSWERED_OUTCOMES = ['sent', 'applied', 'handoff'];

export interface AutopilotOps {
  startRun: typeof startDraftRun;
  apply: typeof applyDraft;
  editOp: typeof editDraftOp;
  cleanTopic: typeof cleanTopic;
  rewriteTopic: typeof rewriteTopic;
  suggestCases: typeof suggestCases;
}

export interface AutopilotDeps extends RunContext {
  ops: AutopilotOps;
}

export const defaultAutopilotOps: AutopilotOps = {
  startRun: startDraftRun,
  apply: applyDraft,
  editOp: editDraftOp,
  cleanTopic,
  rewriteTopic,
  suggestCases,
};

type Row = typeof draftAutopilots.$inferSelect;
type Draft = typeof kbDrafts.$inferSelect;

/** What one step changes. `null` from a step means "nothing yet, try again next tick". */
interface Patch extends Partial<Pick<Row,
  'step' | 'caseIds' | 'runId' | 'runOps' | 'runsStarted' | 'runFailures' | 'noiseRetryUsed' |
  'topicAttempts' | 'pendingFixes' | 'cost'>> {
  logs?: AutopilotLogEntry[];
  /** Stops the autopilot with this owner-facing reason. */
  stop?: string;
  applied?: boolean;
}

type StepFn = (deps: AutopilotDeps, row: Row, draft: Draft, agent: RunAgent) => Promise<Patch | null>;

const entry = (kind: AutopilotLogKind, text: string): AutopilotLogEntry => ({
  at: new Date().toISOString(),
  kind,
  text,
});

/**
 * Whether the row is still `running`, read fresh. The final save is guarded too, but a side
 * effect (an op edit that deletes the draft's runs, a run, an apply) cannot be undone by a
 * dropped save, so each one checks right before it happens: an owner who cancelled and took
 * the draft back by hand must not have it changed underneath them.
 */
async function stillRunning(db: Db, id: string): Promise<boolean> {
  const [row] = await db.select({ status: draftAutopilots.status }).from(draftAutopilots)
    .where(eq(draftAutopilots.id, id));
  return row?.status === 'running';
}

/** Before an op edit: also refuses while a run is in flight, since the edit would delete it. */
async function mayEdit(db: Db, row: Row, draftId: string): Promise<boolean> {
  return !isDraftRunning(draftId) && (await stillRunning(db, row.id));
}

const bodyOf = (op: DraftOp): string => (op.op === 'note_create' || op.op === 'note_update' ? op.body : '');

function llmDeps(deps: AutopilotDeps, agent: RunAgent): TopicFixDeps {
  return {
    model: deps.deps.model,
    key: decryptSecret(agent.openrouterKey!, deps.key, keyAad(agent.id)),
    modelId: agent.model,
    temperature: agent.temperature,
  };
}

// ---------------------------------------------------------------------------------------------
// Steps

const prepareCases: StepFn = async (deps, row, draft, agent) => {
  const { db } = deps;
  const logs: AutopilotLogEntry[] = [];
  let cost = row.cost;

  const enabled = row.caseIds.length === 0
    ? []
    : await db.select({ id: testCases.id }).from(testCases).where(and(
        eq(testCases.agentId, agent.id), eq(testCases.enabled, true), inArray(testCases.id, row.caseIds),
      ));
  const enabledIds = new Set(enabled.map((c) => c.id));
  // The run adds the required correction case on its own; naming it here, first, keeps the
  // count honest and keeps it from being the one the 20-case cap cuts off.
  const [required] = await db.select({ id: testCases.id }).from(testCases)
    .where(eq(testCases.requiredDraftId, draft.id)).limit(1);
  const caseIds = [
    ...(required ? [required.id] : []),
    ...row.caseIds.filter((caseId) => enabledIds.has(caseId) && caseId !== required?.id),
  ];

  const noteOps = draft.ops.filter((op) => topicKey(op) !== null).length;
  const need = Math.min(noteOps, MAX_CASES) - caseIds.length;
  if (need > 0) {
    try {
      const suggestion = await deps.ops.suggestCases(llmDeps(deps, agent), draft.ops);
      cost = addCost(cost, suggestion.cost);
      const picked = suggestion.cases.slice(0, need);
      if (picked.length > 0 && !(await stillRunning(db, row.id))) return null;
      if (picked.length > 0) {
        const inserted = await db.insert(testCases).values(picked.map((c) => ({
          agentId: agent.id,
          title: clampTitle(c.title, CASE_TITLE_MAX),
          messages: c.messages.slice(0, CASE_MESSAGES_MAX).map((m) => clampTitle(m, CASE_MESSAGE_MAX)),
          origin: 'suggested',
        }))).returning({ id: testCases.id });
        caseIds.push(...inserted.map((c) => c.id));
        logs.push(entry('info', `Добавлено ${inserted.length} проверок`));
      }
    } catch (error) {
      // Suggestions only top the set up; the owner's own cases can still carry the run.
      deps.log({ error, autopilotId: row.id }, 'draft autopilot: case suggestion failed');
      logs.push(entry('warn', 'Не удалось подобрать проверки автоматически'));
    }
  }

  if (caseIds.length === 0) return { cost, logs, stop: 'Не из чего собрать проверки' };
  return { caseIds: caseIds.slice(0, MAX_CASES), cost, logs, step: 'clean_topics' };
};

const cleanTopics: StepFn = async (deps, row, draft, agent) => {
  const logs: AutopilotLogEntry[] = [];
  let cost = row.cost;
  let current = draft;
  const llm = llmDeps(deps, agent);

  for (let index = 0; index < draft.ops.length; index += 1) {
    const op = current.ops[index]!;
    if (topicKey(op) === null) continue;
    const title = opTitle(op, current.base);
    const body = bodyOf(op);

    let cleaned;
    try {
      cleaned = await deps.ops.cleanTopic(llm, { title, body });
    } catch (error) {
      // One topic the model could not clean is left as it was; it never stops the autopilot.
      if (error instanceof TopicFixError) cost = addCost(cost, error.cost);
      deps.log({ error, autopilotId: row.id }, 'draft autopilot: topic clean-up failed');
      logs.push(entry('warn', `Не удалось почистить тему „${title}“ — оставлена как есть`));
      continue;
    }
    cost = addCost(cost, cleaned.cost);
    if (cleaned.body === body) continue;

    if (!(await mayEdit(deps.db, row, draft.id))) return null;
    try {
      current = await deps.ops.editOp(deps.db, {
        agentId: agent.id, draftId: draft.id, edit: { action: 'update', index, current: op, body: cleaned.body },
      });
    } catch (error) {
      if (error instanceof ApiError) return { cost, logs, stop: error.message };
      throw error;
    }
    logs.push(entry('fix', cleaned.reason ? `Почищена тема „${title}“: ${cleaned.reason}` : `Почищена тема „${title}“`));
  }

  return { cost, logs, step: 'start_run' };
};

const startRun: StepFn = async (deps, row, draft, agent) => {
  if (row.runsStarted >= AUTOPILOT_MAX_RUNS) {
    return { stop: `Не удалось добиться результата за ${AUTOPILOT_MAX_RUNS} прогона` };
  }
  // A manual run started just before the autopilot: wait for it rather than fail.
  if (isDraftRunning(draft.id)) return null;

  if (!(await stillRunning(deps.db, row.id))) return null;
  let run;
  try {
    run = await deps.ops.startRun(deps, { agent, draft, caseIds: row.caseIds });
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    if (error.statusCode === 429 || isDraftRunning(draft.id)) return null;
    return { stop: error.message };
  }

  const runsStarted = row.runsStarted + 1;
  return {
    runId: run.id,
    runOps: draft.ops,
    runsStarted,
    pendingFixes: null,
    logs: [entry('info', `Прогон ${runsStarted} из ${AUTOPILOT_MAX_RUNS}`)],
    step: 'await_run',
  };
};

const awaitRun: StepFn = async (deps, row, draft, agent) => {
  const { db } = deps;
  // `run_id` goes null when an op edit deleted the run; that proves nothing, like a failed run.
  const [run] = row.runId === null ? [] : await db.select().from(testRuns).where(eq(testRuns.id, row.runId));
  if (run?.status === 'running') return null;

  if (run?.status === 'done') {
    // `runReplay` marks the draft run done a moment before its paired baseline run; reading in
    // between would miss the baseline's cost and its «было» replies.
    const baseline = await pairedBaselineRun(db, run);
    if (baseline?.status === 'running') return null;
  }

  if (!run || run.status !== 'done') {
    // A failed run still spent money, and so did the baseline run its POST paired with it.
    let cost = row.cost;
    if (run) {
      cost = addCost(cost, run.cost);
      const baseline = await pairedBaselineRun(db, run);
      if (baseline && baseline.status !== 'running') cost = addCost(cost, baseline.cost);
    }
    const runFailures = row.runFailures + 1;
    if (runFailures >= AUTOPILOT_MAX_RUN_FAILURES) return { cost, runFailures, runId: null, stop: 'Прогон трижды оборвался' };
    return {
      cost,
      runFailures,
      runId: null,
      logs: [entry('warn', 'Прогон оборвался — запускаем заново')],
      step: 'start_run',
    };
  }

  const read = await readRun(db, run);
  const cost = addCost(addCost(row.cost, read.draftCost), read.baselineCost);

  const [required] = await db.select({ id: testCases.id }).from(testCases)
    .where(eq(testCases.requiredDraftId, draft.id)).limit(1);
  // A case the judge could not score, or whose draft-side turn never answered, proves nothing
  // either way: it must not let the draft through unjudged.
  const unjudged = (result: TestRun['results'][number]): boolean =>
    result.verdict === null || !ANSWERED_OUTCOMES.includes(result.after.outcome);
  const bad = read.results.filter((result) => result.verdict === 'worse' || unjudged(result) || (
    result.caseId === required?.id && result.verdict !== 'better'
  ));

  if (bad.length === 0) {
    if (await isDraftApplicable(db, draft.id, agent.configVersion)) return { cost, step: 'apply' };
    return { cost, logs: [entry('warn', 'База изменилась во время прогона — перепроверяем')], step: 'start_run' };
  }

  const cases = await db.select({ id: testCases.id, title: testCases.title, messages: testCases.messages })
    .from(testCases).where(inArray(testCases.id, bad.map((result) => result.caseId)));
  const caseById = new Map(cases.map((c) => [c.id, c]));

  // Attribution is read against the ops the run started with, never the current draft: op
  // indexes shift when a topic is removed. Only topics still in the draft can be fixed.
  const runOps = row.runOps ?? [];
  const currentKeys = new Set(draft.ops.map(topicKey).filter((k): k is string => k !== null));
  const fixes = new Map<string, FailingCase[]>();
  const unattributed: { title: string; unjudged: boolean }[] = [];
  for (const result of bad) {
    const kase = caseById.get(result.caseId);
    const title = kase?.title ?? 'без названия';
    // Only a real `worse` verdict points at the topics the answer used; an unscored case
    // has nothing to fix and goes the noise-retry way.
    if (unjudged(result) && result.verdict !== 'worse') {
      unattributed.push({ title, unjudged: true });
      continue;
    }
    const keys = [...new Set(result.after.usedOpIndexes
      .map((i) => (runOps[i] ? topicKey(runOps[i]) : null))
      .filter((k): k is string => k !== null && currentKeys.has(k)))];
    if (keys.length === 0) {
      unattributed.push({ title, unjudged: false });
      continue;
    }
    const failing: FailingCase = {
      title,
      messages: kase?.messages ?? [],
      before: result.before?.reply ?? null,
      after: result.after.reply,
      reason: result.verdictReason,
    };
    for (const k of keys) fixes.set(k, [...(fixes.get(k) ?? []), failing]);
  }

  if (fixes.size > 0) {
    // Unattributed cases, if any, are re-judged by the run that follows the fix.
    const pendingFixes: PendingFix[] = [...fixes].map(([k, failing]) => ({
      key: k,
      action: (row.topicAttempts[k] ?? 0) >= AUTOPILOT_MAX_REWRITES ? 'remove' : 'rewrite',
      cases: failing,
    }));
    return { cost, pendingFixes, step: 'fix_topics' };
  }

  const first = unattributed[0]!;
  if (!row.noiseRetryUsed) {
    const text = first.unjudged
      ? `Случай „${first.title}“ не удалось оценить — перепроверяем`
      : `Случай „${first.title}“ хуже, но темы черновика в ответе не участвовали — перепроверяем`;
    return { cost, noiseRetryUsed: true, logs: [entry('warn', text)], step: 'start_run' };
  }
  const reason = first.unjudged
    ? `Случай „${first.title}“ не удалось оценить — проверьте его вручную`
    : `Случай „${first.title}“ стал хуже не из-за тем черновика — проверьте его вручную`;
  return { cost, stop: reason };
};

const fixTopics: StepFn = async (deps, row, draft, agent) => {
  const logs: AutopilotLogEntry[] = [];
  let cost = row.cost;
  const topicAttempts = { ...row.topicAttempts };
  let current = draft;
  const done = (extra: Patch): Patch => ({ cost, logs, topicAttempts, pendingFixes: null, ...extra });

  for (const fix of row.pendingFixes ?? []) {
    const index = current.ops.findIndex((op) => topicKey(op) === fix.key);
    if (index === -1) continue;
    const op = current.ops[index]!;
    const title = opTitle(op, current.base);

    try {
      if (fix.action === 'remove') {
        if (current.ops.length === 1) return done({ stop: 'Все темы убраны — применять нечего' });
        if (!(await mayEdit(deps.db, row, draft.id))) return null;
        current = await deps.ops.editOp(deps.db, {
          agentId: agent.id, draftId: draft.id, edit: { action: 'remove', index, current: op },
        });
        logs.push(entry('remove', `Убрана тема „${title}“: после двух попыток исправления ответ всё ещё хуже`));
        continue;
      }

      topicAttempts[fix.key] = (topicAttempts[fix.key] ?? 0) + 1;
      let rewritten;
      try {
        rewritten = await deps.ops.rewriteTopic(llmDeps(deps, agent), { title, body: bodyOf(op), cases: fix.cases });
      } catch (error) {
        // A failed rewrite still counts as an attempt, so a topic the model cannot fix is
        // eventually removed rather than retried forever.
        if (error instanceof TopicFixError) cost = addCost(cost, error.cost);
        deps.log({ error, autopilotId: row.id }, 'draft autopilot: topic rewrite failed');
        logs.push(entry('warn', `Не удалось переписать тему „${title}“ — оставлена как есть`));
        continue;
      }
      cost = addCost(cost, rewritten.cost);
      if (rewritten.body === bodyOf(op)) {
        logs.push(entry('warn', `Не удалось переписать тему „${title}“ — оставлена как есть`));
        continue;
      }
      if (!(await mayEdit(deps.db, row, draft.id))) return null;
      current = await deps.ops.editOp(deps.db, {
        agentId: agent.id, draftId: draft.id, edit: { action: 'update', index, current: op, body: rewritten.body },
      });
      logs.push(entry('fix', `Переписана тема „${title}“: ${rewritten.reason}`));
    } catch (error) {
      if (error instanceof ApiError) return done({ stop: error.message });
      throw error;
    }
  }

  return done({ step: 'start_run' });
};

const applyStep: StepFn = async (deps, row, draft, agent) => {
  if (!(await stillRunning(deps.db, row.id))) return null;
  try {
    await deps.ops.apply(deps.db, { agentId: agent.id, draftId: draft.id });
  } catch (error) {
    if (error instanceof ApiError) return { stop: error.message };
    throw error;
  }
  return { applied: true, logs: [entry('info', 'Применено')] };
};

const STEPS: Record<AutopilotStep, StepFn> = {
  prepare_cases: prepareCases,
  clean_topics: cleanTopics,
  start_run: startRun,
  await_run: awaitRun,
  fix_topics: fixTopics,
  apply: applyStep,
};

// ---------------------------------------------------------------------------------------------
// The loop

/** Rows being advanced in this process right now: the drain and a route's kick never overlap. */
const inFlight = new Set<string>();

async function save(db: Db, row: Row, patch: Patch): Promise<void> {
  const { logs = [], stop: reason, applied, ...fields } = patch;
  const log = [...row.log, ...logs];
  const finished = reason !== undefined || applied === true;
  if (reason !== undefined) log.push(entry('warn', reason));
  await db
    .update(draftAutopilots)
    .set({
      ...fields,
      log: log.slice(-LOG_MAX),
      updatedAt: new Date(),
      ...(reason !== undefined ? { status: 'stopped', stopReason: reason } : {}),
      ...(applied ? { status: 'applied' } : {}),
      ...(finished ? { finishedAt: new Date() } : {}),
    })
    // A cancel that landed while the step ran wins; this step's result is dropped.
    .where(and(eq(draftAutopilots.id, row.id), eq(draftAutopilots.status, 'running')));
}

async function load(db: Db, id: string): Promise<Row | undefined> {
  const [row] = await db.select().from(draftAutopilots).where(eq(draftAutopilots.id, id));
  return row;
}

export async function advanceAutopilot(deps: AutopilotDeps, id: string): Promise<void> {
  if (inFlight.has(id)) return;
  inFlight.add(id);
  const { db } = deps;
  try {
    const row = await load(db, id);
    if (!row || row.status !== 'running') return;
    const [draft] = await db.select().from(kbDrafts).where(eq(kbDrafts.id, row.draftId));
    const [agent] = await db
      .select({
        id: agents.id,
        configVersion: agents.configVersion,
        model: agents.model,
        temperature: agents.temperature,
        openrouterKey: agents.openrouterKey,
      })
      .from(agents)
      .where(eq(agents.id, row.agentId));
    if (!draft || draft.status !== 'open') return await save(db, row, { stop: 'Черновик уже применён или отброшен' });
    if (!agent?.openrouterKey) return await save(db, row, { stop: 'Нет ключа OpenRouter' });

    const patch = await STEPS[row.step as AutopilotStep](deps, row, draft, agent);
    if (patch) await save(db, row, patch);
  } catch (error) {
    deps.log({ error, autopilotId: id }, 'draft autopilot: step failed');
    try {
      const row = await load(db, id);
      if (row?.status === 'running') await save(db, row, { stop: 'Внутренняя ошибка — попробуйте ещё раз' });
    } catch (saveError) {
      deps.log({ error: saveError, autopilotId: id }, 'draft autopilot: could not record the failure');
    }
  } finally {
    inFlight.delete(id);
  }
}

/** Advances every running autopilot by one step, oldest-touched first, one at a time. */
export async function drainAutopilots(deps: AutopilotDeps): Promise<void> {
  const rows = await deps.db
    .select({ id: draftAutopilots.id })
    .from(draftAutopilots)
    .where(eq(draftAutopilots.status, 'running'))
    .orderBy(asc(draftAutopilots.updatedAt));
  for (const { id } of rows) await advanceAutopilot(deps, id);
}

export async function isAutopilotBusy(db: Db, draftId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: draftAutopilots.id })
    .from(draftAutopilots)
    .where(and(eq(draftAutopilots.draftId, draftId), eq(draftAutopilots.status, 'running')))
    .limit(1);
  return row !== undefined;
}

export function toAutopilotDto(row: Row): DraftAutopilot {
  return {
    id: row.id,
    status: row.status as DraftAutopilot['status'],
    step: row.step as AutopilotStep,
    runsStarted: row.runsStarted,
    maxRuns: AUTOPILOT_MAX_RUNS,
    runId: row.runId,
    caseIds: row.caseIds,
    log: row.log,
    cost: row.cost,
    stopReason: row.stopReason,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt === null ? null : row.finishedAt.toISOString(),
  };
}
