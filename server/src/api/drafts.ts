/**
 * Drafts, the cases they are proven against, and the runs that prove them.
 *
 * A draft is a promise: what was tested is what would land. Nothing here ever writes
 * `agent_rules` or `kb_notes` for real — every draft op a run applies is applied inside
 * `replayCase`'s own transaction, which is always rolled back. The one write this file makes
 * to the live store is bookkeeping: `kb_drafts`, `test_runs`, `test_results`, and the
 * `coach_messages` row a proposal came from.
 *
 * `POST …/coach/messages/:id/draft` is the route `api/coach.ts` left for later — see that
 * file's trailing comment. It lives here, not there, because turning a proposal into a draft
 * is this file's whole job: the four `CoachProposal` kinds each become exactly one `DraftOp`,
 * the same op a manually-built draft or a future generation feature would carry.
 *
 * ## «Было» and «стало», and what each costs
 *
 * «Стало» — the draft's own ops applied — is paid for every case, every run: that half of the
 * table is the whole point of asking. «Было» is the agent as it stands today, and it is
 * reusable: `baselineResults` (`lib/drafts/baseline.ts`) finds the newest `done` run with no
 * draft at the same `config_version` and model, and a case with one costs nothing here. A case
 * without one is run once, empty ops, in the same pass — and that result is written into its
 * own `test_runs` row (`draft_id` null) so the *next* draft's run finds it and pays nothing
 * either. Getting this backwards either wastes the owner's balance re-running an unchanged
 * agent, or — worse — skips a needed baseline call and compares the new draft against a stale
 * «было» from a different config version, which is not what the run claims to show.
 *
 * ## The turn-cap slot
 *
 * `replayCase` asserts a slot is already held (`turnSlotHeld`, `db/turn-cap.ts`) and refuses
 * otherwise — Task 4's ruling. This route takes one right before each `replayCase` call and
 * gives it back in a `finally` immediately after, rather than once for the whole run: a run of
 * twenty cases, each up to two calls, never holds more than one slot at a time this way, so
 * three runs — of any size — can proceed together under the same process-wide cap the sandbox
 * and the coach already share, and a fourth is refused the moment it tries, not after however
 * long the first three take. Held any longer — for a whole case, or the whole run — the same
 * fourth run would be refused even while the pool sat mostly idle. A case that throws cannot
 * leak the slot: the `try`/`finally` around each `replayCase` call is unconditional, the same
 * shape `api/ai.ts`'s sandbox and `api/coach.ts`'s coach already use around their own one call.
 *
 * ## Answering when everything is done
 *
 * Twenty cases at up to two calls each is a request that can run long — there is no attempt
 * here to make it short. The route answers once every case has a result, the same shape
 * `POST …/ai/sandbox` already commits to for one call: the owner's screen has one round trip
 * to show «было» against «стало», not a job id to poll. What the wait buys the owner is
 * `test_runs.status` actually meaning something: `running` while a run is in flight, `done`
 * once every named case has a row in `test_results`, `failed` only when the run itself could
 * not finish — the pool was full mid-run, or something below `replayCase` broke outright — not
 * when a *case* merely answered badly. `runTurn` already turns an ordinary model failure (a
 * timeout, a bad key, a malformed reply) into `outcome: 'failed'` on the result it returns
 * rather than throwing (see `replay.ts`'s own comment on `meteredModel`), so the common case of
 * "the model failed once" is not an exception here at all — it is one ordinary row in
 * `results`, and nineteen good rows around it are not wasted for it. A run that cannot finish
 * — an exception actually escaping the loop — marks both its rows `failed`, keeps whatever
 * `test_results` rows it managed before that, and answers with the error rather than a false
 * `200`; a run that never started (refused on the case count, on a missing number, on the slot
 * cap) never gets a `test_runs` row to begin with.
 *
 * ## Mapping a `CoachProposal` onto a `DraftOp`
 *
 * `toDraftOp` below is the whole mapping, and it is one-to-one: `rule` → `rule_create`,
 * `rule_edit` → `rule_update`, `note` → `note_create`, `note_edit` → `note_update`, each
 * carrying exactly the fields the other side already has a name for. The proposal kind with no
 * op is not a fourth kind at all — it is `proposal: null`, a coach message that answered in
 * words alone, and `POST …/coach/messages/:id/draft` refuses one with 400 before it ever
 * reaches `toDraftOp`.
 *
 * ## `baseOf`, before the draft row exists
 *
 * `baseOf` (`lib/drafts/ops.ts`) is read right before the `kb_drafts` insert, from a plain
 * `db` read rather than from inside the same transaction as that insert — the same looseness
 * `ops.ts`'s own comment on `baseOf` explicitly allows ("the parameter is named `db` only to
 * say what the common case is, not to forbid the other one"). A concurrent edit landing in the
 * gap between the read and the insert is the same shape of race `staleOps`'s own comment
 * already accepts for a neighbouring reorder: `config_version` is the catch-all standing
 * behind it, because the apply route (a later task) refuses any draft not run at the agent's
 * *current* version, and a run against a stale `base` would already have compared against the
 * wrong floor before apply is ever reached. Ordering it this way rather than after the insert
 * also gives the title something to read: an update op names no row of its own (`note_update`
 * carries no path — see `ops.ts`), so `titleFor` below reads the display name `baseOf` just
 * captured rather than inventing a second query for it.
 */
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import {
  coachMessages,
  kbDrafts,
  testCases,
  testResults,
  testRuns,
  whatsappNumbers,
} from '../db/schema.js';
import { releaseTurnSlot, tryTakeTurnSlot } from '../db/turn-cap.js';
import type { Env } from '../env.js';
import type { CoachProposal } from '../lib/ai/coach.js';
import { addCost } from '../lib/ai/turn.js';
import { baselineResults } from '../lib/drafts/baseline.js';
import { baseOf, type DraftBase, type DraftOp } from '../lib/drafts/ops.js';
import { replayCase, type AiDeps, type ReplayResult } from '../lib/drafts/replay.js';
import { ApiError } from '../lib/errors.js';
import { clampTitle } from '../lib/knowledge/split.js';
import { credentialsKey } from '../lib/secret-box.js';
import { isUuid } from '../lib/uuid.js';
import { requireAgent } from './require-agent.js';

/** Matches the sandbox and the coach — see `db/turn-cap.ts`. A run of any size never holds
 * more than one slot at once (see the file comment), so this is not itself the cap on how many
 * cases a run may hold in flight; it is the cap the design settles on for a run request at all. */
const MAX_CASES = 20;

/** A rule or a note's body can run long; a draft's own title is read in a list, not a page. */
const TITLE_MAX = 80;

const RULE_CATEGORIES = ['business', 'tone', 'order', 'forbid'] as const;

const draftOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('note_create'), path: z.string().trim().min(1), body: z.string() }),
  z.object({ op: z.literal('note_update'), noteId: z.string().trim().min(1), body: z.string() }),
  z.object({
    op: z.literal('rule_create'),
    category: z.enum(RULE_CATEGORIES),
    text: z.string().trim().min(1),
    warning: z.string().nullable().optional(),
  }),
  z.object({
    op: z.literal('rule_update'),
    ruleId: z.string().trim().min(1),
    text: z.string().trim().min(1).optional(),
    enabled: z.boolean().optional(),
  }),
]);

const createDraftBody = z.object({
  title: z.string().trim().min(1).max(200),
  ops: z.array(draftOpSchema).min(1),
});

const runBody = z.object({
  caseIds: z.array(z.string().trim().min(1)),
});

/** The one-to-one mapping this file's header comment describes. A proposal is checked by the
 * coach before it is ever stored (`lib/ai/coach.ts`), so every field a `DraftOp` wants is
 * already sitting on the proposal — nothing here re-validates shape, only renames it. */
function toDraftOp(proposal: CoachProposal): DraftOp {
  switch (proposal.kind) {
    case 'rule':
      return { op: 'rule_create', category: proposal.category, text: proposal.text };
    case 'rule_edit':
      return { op: 'rule_update', ruleId: proposal.ruleId, text: proposal.text, enabled: proposal.enabled };
    case 'note':
      return { op: 'note_create', path: proposal.path, body: proposal.body };
    case 'note_edit':
      return { op: 'note_update', noteId: proposal.noteId, body: proposal.body };
    default: {
      const exhaustive: never = proposal;
      throw new Error(`unknown coach proposal: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** What a draft's list entry is named, for a screen that shows many at once. A create op
 * names its own row (`path`, `text`); an update op names none — `note_update` in particular
 * carries no path of its own (see `ops.ts`) — so it falls back to the display name `baseOf`
 * already captured for the row it edits. */
function titleFor(op: DraftOp, base: DraftBase): string {
  switch (op.op) {
    case 'note_create':
      return clampTitle(op.path, TITLE_MAX);
    case 'note_update':
      return clampTitle(base.noteNames?.[op.noteId] ?? 'Заметка', TITLE_MAX);
    case 'rule_create':
      return clampTitle(op.text, TITLE_MAX);
    case 'rule_update':
      return clampTitle(op.text ?? base.ruleNames?.[op.ruleId] ?? 'Правило', TITLE_MAX);
    default: {
      const exhaustive: never = op;
      throw new Error(`unknown draft op: ${JSON.stringify(exhaustive)}`);
    }
  }
}

const toDraft = (row: typeof kbDrafts.$inferSelect) => ({
  id: row.id,
  title: row.title,
  origin: row.origin as 'coach' | 'manual',
  status: row.status as 'open' | 'applied' | 'discarded',
  ops: row.ops,
  base: row.base,
  createdAt: row.createdAt.toISOString(),
  appliedAt: row.appliedAt === null ? null : row.appliedAt.toISOString(),
});

/** The seven `test_results` columns a replay actually fills — never `fields` or `detail`,
 * which `ReplayResult` also carries but which have no column of their own (see that type's
 * comment). Shared by a freshly-run side and one read back out of a reused baseline row, so
 * the response pairs «было» and «стало» in one shape regardless of which of the two paid. */
interface CaseSide {
  reply: string | null;
  usedChunkIds: string[];
  stageId: string | null;
  handoff: boolean;
  handoffReason: string | null;
  outcome: string;
  cost: string;
}

const sideFromReplay = (result: ReplayResult): CaseSide => ({
  reply: result.reply,
  usedChunkIds: result.usedChunkIds,
  stageId: result.stageId,
  handoff: result.handoff,
  handoffReason: result.handoffReason,
  outcome: result.outcome,
  cost: result.cost,
});

const sideFromRow = (row: typeof testResults.$inferSelect): CaseSide => ({
  reply: row.reply,
  usedChunkIds: row.usedChunkIds,
  stageId: row.stageId,
  handoff: row.handoff,
  handoffReason: row.handoffReason,
  outcome: row.outcome,
  cost: row.cost,
});

const resultRow = (runId: string, caseId: string, side: CaseSide) => ({
  runId,
  caseId,
  reply: side.reply,
  usedChunkIds: side.usedChunkIds,
  stageId: side.stageId,
  handoff: side.handoff,
  handoffReason: side.handoffReason,
  outcome: side.outcome,
  cost: side.cost,
});

export function registerDraftRoutes(
  app: FastifyInstance,
  db: Db,
  env: Env,
  guard: preHandlerHookHandler,
  deps: AiDeps,
): void {
  // Every route below is owner-only: a draft is a proposed change to the agent's character,
  // and running one spends the owner's own OpenRouter balance.
  const ownerOnly = requireAgent(db, { role: 'owner' });
  const key = credentialsKey(env);

  /** One agent's draft, or 404 — never another agent's, and never a bare 500 on a malformed id. */
  async function loadDraft(agentId: string, draftId: string): Promise<typeof kbDrafts.$inferSelect> {
    if (!isUuid(draftId)) throw new ApiError(404, 'Черновик не найден');
    const [row] = await db
      .select()
      .from(kbDrafts)
      .where(and(eq(kbDrafts.id, draftId), eq(kbDrafts.agentId, agentId)));
    if (!row) throw new ApiError(404, 'Черновик не найден');
    return row;
  }

  /** A real number to invent the case's fake conversation on, preferring an enabled one — the
   * same choice `POST …/ai/sandbox` makes and the same reason: a run that invented a number
   * would test an agent that could never actually answer. */
  async function ownNumber(agentId: string): Promise<string> {
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

  app.post(
    '/api/agents/:agentId/drafts',
    { preHandler: [guard, ownerOnly] },
    async (req) => {
      const agentId = req.agent!.id;
      const parsed = createDraftBody.safeParse(req.body);
      if (!parsed.success) throw new ApiError(400, 'Не удалось разобрать черновик');

      const base = await baseOf(db, agentId, parsed.data.ops);
      const [row] = await db
        .insert(kbDrafts)
        .values({
          agentId,
          title: parsed.data.title,
          origin: 'manual',
          status: 'open',
          ops: parsed.data.ops,
          base,
          createdBy: req.user!.id,
        })
        .returning();

      return toDraft(row!);
    },
  );

  app.get(
    '/api/agents/:agentId/drafts/:draftId',
    { preHandler: [guard, ownerOnly] },
    async (req) => {
      const { draftId } = req.params as { draftId: string };
      const row = await loadDraft(req.agent!.id, draftId);
      return toDraft(row);
    },
  );

  app.post(
    '/api/agents/:agentId/drafts/:draftId/runs',
    {
      preHandler: [guard, ownerOnly],
      // The same 20-a-minute bound the sandbox and the coach give a route that spends real
      // money — the in-flight cap below is what stops one run from emptying the pool, this is
      // what stops a script from starting run after run after each finishes.
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (req) => {
      const agentId = req.agent!.id;
      const { draftId } = req.params as { draftId: string };
      const draft = await loadDraft(agentId, draftId);

      const parsed = runBody.safeParse(req.body);
      if (!parsed.success) throw new ApiError(400, 'Не удалось разобрать список случаев');
      // Deduplicated before the count is checked against the limit or a row is written: a
      // repeated id is one case to run, not two, and left alone it would trip `test_results`'
      // own `(run_id, case_id)` uniqueness on the second write and fail the whole run for a
      // client mistake this route can just as easily not make in the first place.
      const caseIds = [...new Set(parsed.data.caseIds)];

      if (caseIds.length > MAX_CASES) {
        throw new ApiError(400, 'За один прогон можно проверить не больше двадцати случаев');
      }
      // A malformed id is exactly as absent as one that does not exist — comparing it against
      // a uuid column would make Postgres raise instead of this route answering 404 (`uuid.ts`).
      if (caseIds.some((id) => !isUuid(id))) throw new ApiError(404, 'Случай не найден');

      const caseRows =
        caseIds.length === 0
          ? []
          : await db
              .select({ id: testCases.id, messages: testCases.messages })
              .from(testCases)
              .where(and(eq(testCases.agentId, agentId), inArray(testCases.id, caseIds)));
      const casesById = new Map(caseRows.map((row) => [row.id, row]));
      if (casesById.size !== caseIds.length) throw new ApiError(404, 'Случай не найден');

      // Resolved before any bookkeeping row is written: a run refused for want of a number
      // should leave no trace of a run that never started.
      const numberId = caseIds.length === 0 ? null : await ownNumber(agentId);

      const configVersion = req.agent!.configVersion;
      const model = req.agent!.model;
      const existingBaselines = await baselineResults(db, agentId, caseIds, configVersion, model);
      const needsBaseline = caseIds.filter((id) => !existingBaselines.has(id));

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

      /** Takes a slot for exactly one `replayCase` call and gives it back immediately after —
       * see the file comment for why per-call, not per-case or per-run. */
      async function replayOneSide(ops: DraftOp[], messages: string[]): Promise<ReplayResult> {
        if (!tryTakeTurnSlot()) {
          throw new ApiError(429, 'Прогоны заняты. Попробуйте через несколько секунд.');
        }
        try {
          return await replayCase(db, deps, { agentId, numberId: numberId!, key, messages, ops });
        } finally {
          releaseTurnSlot();
        }
      }

      const results: { caseId: string; before: CaseSide; after: CaseSide }[] = [];
      let draftCost = '0';
      let baselineCost = '0';

      try {
        for (const caseId of caseIds) {
          const kase = casesById.get(caseId)!;

          // «Стало» — always paid, every case, every run.
          const after = await replayOneSide(draft.ops, kase.messages);
          draftCost = addCost(draftCost, after.cost);
          await db.insert(testResults).values(resultRow(draftRun!.id, caseId, sideFromReplay(after)));

          // «Было» — read back when a baseline already exists at this version and model,
          // paid for and stored as one only when it does not.
          const cached = existingBaselines.get(caseId);
          let before: CaseSide;
          if (cached) {
            before = sideFromRow(cached);
          } else {
            const baseline = await replayOneSide([], kase.messages);
            baselineCost = addCost(baselineCost, baseline.cost);
            await db.insert(testResults).values(resultRow(baselineRun!.id, caseId, sideFromReplay(baseline)));
            before = sideFromReplay(baseline);
          }

          results.push({ caseId, before, after: sideFromReplay(after) });
        }

        await db
          .update(testRuns)
          .set({ status: 'done', cost: draftCost, finishedAt: new Date() })
          .where(eq(testRuns.id, draftRun!.id));
        if (baselineRun) {
          await db
            .update(testRuns)
            .set({ status: 'done', cost: baselineCost, finishedAt: new Date() })
            .where(eq(testRuns.id, baselineRun.id));
        }
      } catch (error) {
        // The run could not finish — the pool was full mid-run, or something below
        // `replayCase` broke outright. Whatever `test_results` rows already landed stay; the
        // run itself is marked so nothing later mistakes it for a complete answer, and the
        // error is answered honestly rather than papered over with a false 200.
        await db
          .update(testRuns)
          .set({ status: 'failed', cost: draftCost, finishedAt: new Date() })
          .where(eq(testRuns.id, draftRun!.id));
        if (baselineRun) {
          await db
            .update(testRuns)
            .set({ status: 'failed', cost: baselineCost, finishedAt: new Date() })
            .where(eq(testRuns.id, baselineRun.id));
        }
        throw error;
      }

      return { id: draftRun!.id, draftId: draft.id, status: 'done', cost: draftCost, results };
    },
  );

  app.get(
    '/api/agents/:agentId/drafts/:draftId/runs/:runId',
    { preHandler: [guard, ownerOnly] },
    async (req) => {
      const agentId = req.agent!.id;
      const { draftId, runId } = req.params as { draftId: string; runId: string };
      // 404s the draft first — the same reason `loadDraft` is used everywhere else — and then
      // pins the run to *this* draft, not merely to this agent: a baseline run's `draft_id` is
      // null and belongs to no draft at all, so nesting the URL under one and not checking it
      // would let a run answer for a draft it was never scored against.
      const draft = await loadDraft(agentId, draftId);
      if (!isUuid(runId)) throw new ApiError(404, 'Прогон не найден');

      const [run] = await db
        .select()
        .from(testRuns)
        .where(and(eq(testRuns.id, runId), eq(testRuns.agentId, agentId), eq(testRuns.draftId, draft.id)));
      if (!run) throw new ApiError(404, 'Прогон не найден');

      const rows = await db.select().from(testResults).where(eq(testResults.runId, runId));

      return {
        id: run.id,
        draftId: run.draftId,
        configVersion: run.configVersion,
        model: run.model,
        status: run.status as 'running' | 'done' | 'failed',
        cost: run.cost,
        startedAt: run.startedAt.toISOString(),
        finishedAt: run.finishedAt === null ? null : run.finishedAt.toISOString(),
        results: rows.map((row) => ({ caseId: row.caseId, ...sideFromRow(row) })),
      };
    },
  );

  app.post(
    '/api/agents/:agentId/coach/messages/:id/draft',
    { preHandler: [guard, ownerOnly] },
    async (req) => {
      const agentId = req.agent!.id;
      const { id } = req.params as { id: string };
      if (!isUuid(id)) throw new ApiError(404, 'Сообщение не найдено');

      const [message] = await db
        .select()
        .from(coachMessages)
        .where(and(eq(coachMessages.id, id), eq(coachMessages.agentId, agentId)));
      if (!message) throw new ApiError(404, 'Сообщение не найдено');
      if (message.proposal === null) throw new ApiError(400, 'В этом сообщении нет предложения');
      if (message.status !== 'pending') throw new ApiError(409, 'Предложение уже обработано');

      const op = toDraftOp(message.proposal);
      const base = await baseOf(db, agentId, [op]);
      const title = titleFor(op, base);

      const draft = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(kbDrafts)
          .values({ agentId, title, origin: 'coach', status: 'open', ops: [op], base, createdBy: req.user!.id })
          .returning();
        await tx
          .update(coachMessages)
          .set({ status: 'drafted', draftId: row!.id })
          .where(eq(coachMessages.id, id));
        return row!;
      });

      return toDraft(draft);
    },
  );
}
