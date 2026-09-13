/**
 * Starting a draft run: the checks, the bookkeeping rows and the detached replay behind them.
 *
 * Shared by `POST …/drafts/:draftId/runs` and the autopilot engine, so it depends only on its
 * arguments, never on a request. `api/drafts.ts`'s file comment explains the design at length
 * ("The run is asynchronous", "Refusing a run before it costs anything", "The turn-cap slot",
 * "Answering as the table fills"); the comments here keep only the why of each guard.
 */
import type { TestRun } from '@rakurs/contract';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../../db/client.js';
import { kbDrafts, testCases, testResults, testRuns, whatsappNumbers } from '../../db/schema.js';
import { releaseTurnSlot, takeTurnSlotWaiting, turnSlotAvailable } from '../../db/turn-cap.js';
import { addCost, keyAad } from '../ai/turn.js';
import { ApiError, isDuplicate } from '../errors.js';
import { decryptSecret } from '../secret-box.js';
import { isUuid } from '../uuid.js';
import { annotate, type AnnotateDeps } from './annotate.js';
import { baselineResults } from './baseline.js';
import { MissingDraftRowError, type DraftBase, type DraftOp } from './ops.js';
import { replayCase, type AiDeps, type ReplayResult } from './replay.js';

/** Matches the sandbox and the coach — see `db/turn-cap.ts`. A run never holds more than one
 * slot at once, so this is the cap on a run request's size, not on cases in flight. */
export const MAX_CASES = 20;

export interface RunContext {
  db: Db;
  deps: AiDeps;
  key: Buffer;
  log: (obj: object, msg: string) => void;
}

/** The fields of the agent row a run reads — the same types `req.agent` carries. */
export interface RunAgent {
  id: string;
  configVersion: number;
  model: string;
  temperature: string;
  openrouterKey: string | null;
}

/**
 * Which drafts have a run in flight right now, in this process. Module-level, like
 * `db/turn-cap.ts`'s counter: there is one process in production, and every server instance a
 * test builds shares it. An entry lives until the detached replay finishes, not until the
 * request that started it answers.
 */
const runningDrafts = new Set<string>();

export function isDraftRunning(draftId: string): boolean {
  return runningDrafts.has(draftId);
}

const runBody = z.object({
  caseIds: z.array(z.string().trim().min(1)),
});

/** The `test_results` columns a replay fills. Shared by a freshly-run side and one read back
 * out of a reused baseline row, so «было» and «стало» come back in one shape. */
export interface CaseSide {
  reply: string | null;
  usedChunkIds: string[];
  usedOpIndexes: number[];
  stageId: string | null;
  handoff: boolean;
  handoffReason: string | null;
  outcome: string;
  cost: string;
}

/** A `CaseSide` plus who paid for it this time: `'paid'` when this run wrote the row,
 * `'reused'` when an existing baseline answered it. Never a stored column. */
export interface CaseSideOut extends CaseSide {
  origin: 'paid' | 'reused';
}

export const sideFromReplay = (result: ReplayResult): CaseSide => ({
  reply: result.reply,
  usedChunkIds: result.usedChunkIds,
  usedOpIndexes: result.usedOpIndexes,
  stageId: result.stageId,
  handoff: result.handoff,
  handoffReason: result.handoffReason,
  outcome: result.outcome,
  cost: result.cost,
});

export const sideFromRow = (row: typeof testResults.$inferSelect): CaseSide => ({
  reply: row.reply,
  usedChunkIds: row.usedChunkIds,
  usedOpIndexes: row.usedOpIndexes,
  stageId: row.stageId,
  handoff: row.handoff,
  handoffReason: row.handoffReason,
  outcome: row.outcome,
  cost: row.cost,
});

/** `verdict`/`verdictReason` are only ever written onto the draft's own «стало» row: the
 * baseline row is what «было» is, not a comparison of anything. */
export const resultRow = (
  runId: string,
  caseId: string,
  side: CaseSide,
  verdict: { verdict: string; reason: string } | null = null,
) => ({
  runId,
  caseId,
  reply: side.reply,
  usedChunkIds: side.usedChunkIds,
  usedOpIndexes: side.usedOpIndexes,
  stageId: side.stageId,
  handoff: side.handoff,
  handoffReason: side.handoffReason,
  outcome: side.outcome,
  cost: side.cost,
  verdict: verdict?.verdict ?? null,
  verdictReason: verdict?.reason ?? null,
});

/** The Russian text for a draft op naming a note or rule that is gone. `base` still holds the
 * last name the row had; a row the draft never photographed falls back to a generic label. */
export function missingRowMessage(error: MissingDraftRowError, base: DraftBase): string {
  const name = error.kind === 'note' ? base.noteNames?.[error.id] : base.ruleNames?.[error.id];
  const label = error.kind === 'note' ? 'Заметка' : 'Правило';
  return `${name ? `«${name}»` : label} была удалена с тех пор, как сделан черновик — обновите его и повторите`;
}

/** A `note_create` landing on a path another note already took raises a raw Postgres unique
 * violation from `saveNote`, not a typed error, and `staleOps` cannot see it coming because
 * the draft never photographed that other note. Both the run and apply catch it. */
export const DUPLICATE_NOTE_PATH_MESSAGE =
  'Черновик создаёт заметку с путём, который уже занят другой заметкой — переименуйте или удалите её и повторите';

/** A real number to invent the case's conversation on, preferring an enabled one — a run on an
 * invented number would test an agent that could never actually answer. */
export async function ownNumber(db: Db, agentId: string): Promise<string> {
  const [number] = await db
    .select({ id: whatsappNumbers.id })
    .from(whatsappNumbers)
    .where(eq(whatsappNumbers.agentId, agentId))
    .orderBy(desc(whatsappNumbers.enabled), asc(whatsappNumbers.createdAt))
    .limit(1);
  if (!number) {
    throw new ApiError(409, 'Сначала подключите номер WhatsApp — агенту некуда отвечать');
  }
  return number.id;
}

/**
 * Everything a run does after it is admitted, detached from whoever started it: «стало» always
 * paid, «было» read back or paid once, one `test_results` row per side per case, `test_runs`
 * marked `done` or `failed` on the way out. An error has nowhere to answer to, so it goes into
 * `ctx.log` and the run's own `status`.
 */
async function runReplay(ctx: RunContext, input: {
  agentId: string;
  numberId: string;
  draft: typeof kbDrafts.$inferSelect;
  casesById: Map<string, { id: string; messages: string[]; enabled: boolean; expectation: string | null }>;
  runIds: string[];
  existingBaselines: Map<string, typeof testResults.$inferSelect>;
  draftRun: typeof testRuns.$inferSelect;
  baselineRun: typeof testRuns.$inferSelect | null;
  // Decrypted once up front; null exactly when the agent has no OpenRouter key.
  annotateDeps: AnnotateDeps | null;
}): Promise<void> {
  const { db, deps, key } = ctx;
  const { agentId, numberId, draft, casesById, runIds, existingBaselines, draftRun, baselineRun, annotateDeps } = input;

  /** One slot per `replayCase` call, waited for with no bound: nothing is waiting on this
   * returning quickly, and once admitted a run finishes rather than being cut off partway. */
  async function replayOneSide(ops: DraftOp[], messages: string[]): Promise<ReplayResult> {
    const acquired = await takeTurnSlotWaiting();
    if (!acquired) {
      // Unreachable with the unbounded wait; kept as a defensive fallback that only reaches the log.
      throw new Error('turn-cap: gave up waiting for a slot other runs are holding');
    }
    try {
      return await replayCase(db, deps, { agentId, numberId, key, messages, ops });
    } finally {
      releaseTurnSlot();
    }
  }

  let draftCost = '0';
  let baselineCost = '0';
  // Baseline rows this run actually wrote — decides the baseline run's final status.
  let baselineWritten = 0;

  try {
    for (const caseId of runIds) {
      const kase = casesById.get(caseId)!;

      // «Стало» — always paid, every case, every run.
      const after = await replayOneSide(draft.ops, kase.messages);
      draftCost = addCost(draftCost, after.cost);

      // «Было» — read back when a baseline exists at this version and model, paid and stored
      // otherwise. Needed before the annotation, which compares both replies.
      let beforeReply: string | null;
      if (existingBaselines.has(caseId)) {
        beforeReply = existingBaselines.get(caseId)!.reply;
      } else {
        const baseline = await replayOneSide([], kase.messages);
        baselineCost = addCost(baselineCost, baseline.cost);
        await db.insert(testResults).values(resultRow(baselineRun!.id, caseId, sideFromReplay(baseline)));
        baselineWritten += 1;
        beforeReply = baseline.reply;
      }

      // `annotate` never throws; a call that answered but did not parse still carries its cost,
      // which is added whether or not there is a verdict to write.
      const annotation = annotateDeps
        ? await annotate(annotateDeps, {
            expectation: kase.expectation,
            question: kase.messages[kase.messages.length - 1] ?? '',
            before: beforeReply,
            after: after.reply,
          })
        : null;
      if (annotation) draftCost = addCost(draftCost, annotation.cost);
      const verdict =
        annotation && annotation.verdict !== null ? { verdict: annotation.verdict, reason: annotation.reason! } : null;

      await db.insert(testResults).values(resultRow(draftRun.id, caseId, sideFromReplay(after), verdict));
    }

    await db
      .update(testRuns)
      .set({ status: 'done', cost: draftCost, finishedAt: sql`now()` })
      .where(eq(testRuns.id, draftRun.id));
    if (baselineRun) {
      await db
        .update(testRuns)
        .set({ status: 'done', cost: baselineCost, finishedAt: sql`now()` })
        .where(eq(testRuns.id, baselineRun.id));
    }
  } catch (error) {
    // Rows that already landed stay; the run is marked so nothing mistakes it for complete.
    await db
      .update(testRuns)
      .set({ status: 'failed', cost: draftCost, finishedAt: sql`now()` })
      .where(eq(testRuns.id, draftRun.id));
    if (baselineRun) {
      // A baseline run with at least one row is `done`: those paid-for rows stay reusable.
      await db
        .update(testRuns)
        .set({ status: baselineWritten > 0 ? 'done' : 'failed', cost: baselineCost, finishedAt: sql`now()` })
        .where(eq(testRuns.id, baselineRun.id));
    }
    const detail = error instanceof MissingDraftRowError
      ? missingRowMessage(error, draft.base)
      : isDuplicate(error)
        ? DUPLICATE_NOTE_PATH_MESSAGE
        : undefined;
    ctx.log({ error, runId: draftRun.id, detail }, 'draft run: replay failed');
  }
}

/**
 * Admits a run of `draft` and answers with it at once, `status: 'running'`; the replay runs
 * detached behind the answer. Every refusal happens before a row is written or a call is made,
 * because a run is expensive and shows no progress — precisely what a double click repeats.
 *
 * `caseIds` is parsed here, after the running check, so a second click on a running draft is
 * answered 409 whatever it sent.
 */
export async function startDraftRun(
  ctx: RunContext,
  input: { agent: RunAgent; draft: typeof kbDrafts.$inferSelect; caseIds: unknown },
): Promise<TestRun> {
  const { db, deps, key } = ctx;
  const { agent, draft } = input;
  const agentId = agent.id;

  // Checked and set with no `await` in between, so two concurrent requests cannot both pass.
  if (runningDrafts.has(draft.id)) {
    throw new ApiError(409, 'Этот черновик уже проверяется — дождитесь окончания прогона');
  }
  runningDrafts.add(draft.id);

  // Released here only on an early throw; once admitted, the detached replay's `finally` owns it.
  let admitted = false;
  try {
    const parsed = runBody.safeParse({ caseIds: input.caseIds });
    if (!parsed.success) throw new ApiError(400, 'Не удалось разобрать список случаев');
    // Deduplicated before the limit or any write: a repeated id would trip `test_results`'
    // `(run_id, case_id)` uniqueness and fail the whole run.
    const [requiredCase] = await db.select({ id: testCases.id }).from(testCases)
      .where(eq(testCases.requiredDraftId, draft.id)).limit(1);
    const caseIds = [...new Set([...parsed.data.caseIds, ...(requiredCase ? [requiredCase.id] : [])])];

    // An empty run would satisfy the apply gate without a single case checked.
    if (caseIds.length === 0) {
      throw new ApiError(400, 'Нужен хотя бы один случай для прогона');
    }
    if (caseIds.length > MAX_CASES) {
      throw new ApiError(400, 'За один прогон можно проверить не больше двадцати случаев');
    }
    // A malformed id against a uuid column would make Postgres raise instead of a 404.
    if (caseIds.some((id) => !isUuid(id))) throw new ApiError(404, 'Случай не найден');

    const caseRows = await db
      .select({
        id: testCases.id,
        messages: testCases.messages,
        enabled: testCases.enabled,
        expectation: testCases.expectation,
      })
      .from(testCases)
      .where(and(eq(testCases.agentId, agentId), inArray(testCases.id, caseIds)));
    const casesById = new Map(caseRows.map((row) => [row.id, row]));
    if (casesById.size !== caseIds.length) throw new ApiError(404, 'Случай не найден');

    // A disabled case stays named but is never run: a stale list must not keep paying for it.
    const runIds = caseIds.filter((id) => casesById.get(id)!.enabled);
    if (requiredCase && !casesById.get(requiredCase.id)!.enabled) {
      throw new ApiError(409, 'Обязательный случай исправления отключён');
    }
    if (runIds.length === 0) {
      throw new ApiError(400, 'Все выбранные случаи отключены — включите хотя бы один');
    }

    // Before any bookkeeping row: a run refused for want of a number leaves no trace.
    const numberId = await ownNumber(db, agentId);

    const configVersion = agent.configVersion;
    const model = agent.model;
    const existingBaselines = await baselineResults(db, agentId, runIds, configVersion, model);
    const needsBaseline = runIds.filter((id) => !existingBaselines.has(id));

    const annotateDeps: AnnotateDeps | null =
      agent.openrouterKey === null
        ? null
        : {
            model: deps.model,
            key: decryptSecret(agent.openrouterKey, key, keyAad(agentId)),
            modelId: model,
            temperature: agent.temperature,
          };

    // A peek, not a reservation: refusing here costs nothing; the real per-call reservation
    // happens inside `runReplay`.
    if (!turnSlotAvailable()) {
      throw new ApiError(429, 'Прогоны заняты. Попробуйте через несколько секунд.');
    }

    const [draftRun] = await db
      .insert(testRuns)
      .values({ agentId, draftId: draft.id, configVersion, model, status: 'running' })
      .returning();
    const [baselineRun] =
      needsBaseline.length === 0
        ? [null]
        : await db
            .insert(testRuns)
            .values({ agentId, draftId: null, configVersion, model, status: 'running' })
            .returning();

    admitted = true;

    // `setImmediate`, like `whatsapp-webhook.ts`, so the caller's answer goes out first.
    setImmediate(() => {
      void runReplay(ctx, {
        agentId,
        numberId,
        draft,
        casesById,
        runIds,
        existingBaselines,
        draftRun: draftRun!,
        baselineRun,
        annotateDeps,
      })
        // Backstop for `runReplay`'s own catch failing (its updates losing the connection, say):
        // an unhandled rejection would kill the process and every other run with it.
        .catch((error) => {
          ctx.log({ error, runId: draftRun!.id }, 'draft run: replay failed to record its own failure');
        })
        .finally(() => {
          runningDrafts.delete(draft.id);
        });
    });

    return {
      id: draftRun!.id,
      draftId: draft.id,
      configVersion: draftRun!.configVersion,
      model: draftRun!.model,
      status: 'running' as const,
      draftCost: '0',
      baselineCost: '0',
      // `TestRun.results` is not optional: `RunTable.tsx` reads its length unguarded while running.
      results: [],
      startedAt: draftRun!.startedAt.toISOString(),
      finishedAt: null,
    };
  } finally {
    if (!admitted) runningDrafts.delete(draft.id);
  }
}
