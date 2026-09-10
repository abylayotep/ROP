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
 * A disabled case stays named in a request's `caseIds` but is never run — a stale list from a
 * tab left open must not go on paying for a case the owner has since switched off. `enabled` is
 * read alongside each case row and filtered before anything is spent, not merely before it is
 * shown.
 *
 * ## The run is asynchronous
 *
 * `POST …/drafts/:draftId/runs` answers the instant a run is admitted — before a single case
 * has been replayed, not once every case has a result. `deploy/nginx.conf` gives every request
 * 120 seconds before it gives up on it (`proxy_read_timeout`), and twenty cases at up to two
 * sides each, up to two model attempts a call, each attempt bounded at the model's own sixty
 * seconds, blows past that in the ordinary case, not only a pathological one — the owner would
 * watch their own request die with a 504 while the run it started keeps spending their balance
 * behind a response that never arrives, never even learning the run's own id to look it up by.
 * `test_runs.status` already had `'running'` as a value before this fix; that value only means
 * something if the request that inserted the row can answer before the row leaves it.
 *
 * So the route still does exactly the validating, refusing and bookkeeping it always did — same
 * order, same refusals, same two rows inserted — and then, instead of awaiting the replay loop
 * before answering, hands that loop to `setImmediate` and answers right away with the run's id
 * and `status: 'running'`. `GET …/runs/:runId` (below) is how the rest is read: it answers with
 * whatever `test_results` rows exist yet, so a client polling it watches the table fill, the
 * same way `api/whatsapp-webhook.ts` already answers Meta before draining the CAPI queue behind
 * the response — see that file's own comment for the pattern this follows.
 *
 * Two things change shape once nothing is waiting on the HTTP response any more:
 *
 * - **The `runningDrafts` lock** (below) used to be released in a `finally` wrapped around the
 *   whole handler. It still is, but "the whole handler" now means the detached replay too — the
 *   lock is only ever dropped once that finishes, in *its own* `finally`, not when the response
 *   goes out. A second run of the same draft is refused with 409 for exactly as long as the
 *   first one is actually still working, not merely for as long as its request took.
 * - **An error has nowhere left to answer to.** A `MissingDraftRowError` (see "A deleted note
 *   or rule" below) used to become a synchronous Russian 409, the response itself. It cannot any
 *   more — the response already went out — so every error the loop throws, this one included,
 *   is caught in one place: the run's own `test_runs` rows are marked the way they always were
 *   on failure (see "Answering as the table fills" below), and the error is logged
 *   (`app.log.error`) rather than thrown further, the same shape `whatsapp-webhook.ts` already
 *   uses for its own detached work. The owner's signal is the run's `status`, not a message
 *   naming what went wrong — `test_runs` has no column for that, and adding one to recover
 *   detail this feature has never promised felt like more schema than any of this asked for;
 *   the exact reason is one `app.log.error` line away for whoever is debugging it.
 *
 * `takeTurnSlotWaiting`'s own bound — see "The turn-cap slot" below — is unaffected by this
 * change; it still refuses to wait forever the same way it always has, only now from inside the
 * detached loop rather than the request itself.
 *
 * ## A restart, and the `running` row it leaves behind
 *
 * A run's own loop lives only in the memory of the process replaying it — nothing about it is
 * written anywhere durable enough for a different process, or this one restarted, to pick back
 * up. If the process dies mid-run, its `test_runs` row is left reading `'running'` forever, and
 * the in-memory `runningDrafts` lock that would have refused a second run of the same draft is
 * gone the moment the process is: nothing left standing says the row is a lie.
 * `reconcileOrphanedRuns` below sweeps every row still `'running'` to `'failed'` — called once
 * from `index.ts`, before `app.listen()`, early enough that nothing legitimately `running` can
 * exist yet to be caught by mistake (see that function's own comment for why it lives there and
 * not on a Fastify hook every test's own `buildServer` would trip too). Nothing already paid for is
 * lost by marking it so: `baselineResults` only ever reuses a run with `status = 'done'`, so a
 * `running` row was never going to be reused either way, and the owner's screen gets an honest
 * `'failed'` instead of a progress bar that was never going to move again.
 *
 * ## Refusing a run before it costs anything
 *
 * Three refusals happen before a single row is written or a single call is made, because a run
 * is expensive (up to forty model calls, minutes of wall clock) and shows no progress while it
 * runs — precisely the shape of request a double click repeats:
 *
 * - **A draft with a run already in flight** answers 409. `runningDrafts` below is a plain
 *   in-process `Set`, not the turn-cap counter — this is a business rule about which *draft* is
 *   being tested, not about how many database connections a slow model call is holding, and the
 *   two must not be confused: a fourth run of a *different* draft is refused by the turn-cap
 *   (429, below); a second run of the *same* draft is refused by this Set regardless of whether
 *   any turn-cap slot is free. Checked and set synchronously, with no `await` between the check
 *   and the add, so two concurrent requests for the same draft cannot both pass it — Node's
 *   single-threaded event loop makes that atomic without anything fancier.
 * - **More than twenty cases, or none at all.** An empty `caseIds` used to insert a `done` run
 *   at the agent's current `config_version` — literally satisfying the apply gate the spec
 *   describes without a single case ever having been checked. There is no such thing as a run
 *   that proves nothing, so it is refused rather than accepted as a no-op.
 * - **Every slot already taken.** See "The turn-cap slot" below.
 *
 * ## The turn-cap slot
 *
 * `replayCase` asserts a slot is already held (`turnSlotHeld`, `db/turn-cap.ts`) and refuses
 * otherwise — Task 4's ruling. This route still takes one slot per `replayCase` call, not once
 * for the whole run — a run of twenty cases, each up to two calls, never holds more than one
 * slot at a time this way, so three runs, of any size, can proceed together under the same
 * process-wide cap the sandbox and the coach already share. What changed is what happens when
 * none is free, and it now depends on whether the run has started spending yet:
 *
 * - **At the door**, before either `test_runs` row is written, `turnSlotAvailable` — a peek at
 *   the same counter, not a reservation — decides whether to admit the run at all. Refused here
 *   costs the owner nothing: no row, no call. It can race (two runs might both see a slot free
 *   a moment before both actually need one) and that is fine — see that function's own comment.
 * - **From the first case on**, once the run is admitted and its rows exist, every
 *   `replayCase` call goes through `takeTurnSlotWaiting` instead: it waits for a slot, bounded,
 *   rather than throwing the instant none is free. A fourth run used to be able to pass at case
 *   one, spend real money through case *k*, and then be refused outright at case *k+1* for a
 *   reason that has nothing to do with what it had already paid for — once admitted, a run
 *   finishes rather than being cut off partway through. `takeTurnSlotWaiting`'s own comment
 *   says what the wait is bounded to and why.
 *
 * A case that throws cannot leak the slot: the `try`/`finally` around each `replayCase` call is
 * unconditional, the same shape `api/ai.ts`'s sandbox and `api/coach.ts`'s coach already use
 * around their own one call.
 *
 * ## Answering as the table fills
 *
 * Twenty cases at up to two calls each is a request that can run long — there is no attempt
 * here to make it short, and (see "The run is asynchronous" above) no reason left to: the owner
 * gets the run's id back immediately and watches «было»/«стало» fill in over `GET …/runs/:runId`
 * as `test_results` gains a row per case, rather than one round trip that answers only once
 * everything is done.
 *
 * `test_runs.status` means three different things depending on which run and which column you
 * are looking at, and all three are spelled `'failed'`:
 *
 * 1. **A draft-side run**, marked `failed` when the request itself could not finish — the pool
 *    stayed empty past the wait bound, or something below `replayCase` broke outright. Its rows
 *    are never reused as a baseline regardless of status (`baselineResults` only ever reads a
 *    run with `draft_id is null`), so this is purely informational: the run did not complete.
 * 2. **A baseline-side run**, marked `failed` only when it produced *zero* usable rows. One or
 *    more, and it is `done` even though the request that made it may have thrown partway
 *    through — see the next paragraph. A baseline run's status describes whether its rows may
 *    be reused, not whether the request that created it finished; those used to be the same
 *    question and are not any more.
 * 3. **`test_results.outcome`** — a different column, on a per-*case* row, and an entirely
 *    ordinary event: `runTurn` already turns a bad key, a timeout, or a malformed reply into
 *    `outcome: 'failed'` on the result it returns rather than throwing (see `replay.ts`'s own
 *    comment on `meteredModel`), so "the model failed once" is one ordinary row in `results`,
 *    not an exception, and the other cases around it are not wasted for it.
 *
 * On (1)/(2): a baseline run that produced at least one result before the run it belonged to
 * threw is marked `done`, not `failed` — up to nineteen already-paid-for baseline rows used to
 * become permanently unreachable (and re-paid for by the next run) over one broken case, purely
 * because the whole request wrapping them didn't finish cleanly. The draft-side run's own
 * status keeps the older, stricter meaning, because nothing ever reuses it either way.
 *
 * A run refused before it is admitted (the case count, an empty list, a missing number, the
 * turn-cap door) never gets a `test_runs` row at all — see "Refusing a run before it costs
 * anything" above.
 *
 * ## A deleted note or rule, named by a draft
 *
 * `applyOps` (`lib/drafts/ops.ts`) throws `MissingDraftRowError` when an update op names a row
 * that is gone — deleted between the draft being made and the run that replays it. Ops apply
 * before the first model call in every case (see `replayCase`), so no model call is ever spent
 * chasing a draft that could never have applied; the draft's own `base` (`baseOf`, captured
 * when the draft was made) still holds the display name of the missing row, the same photograph
 * `staleOps` reads for the same reason, and `missingRowMessage` below turns the two into a
 * Russian sentence. What happens to that sentence is the general answer "The run is
 * asynchronous" above already gives for any error the loop throws: it is logged, and the run's
 * own `test_runs` row is marked `failed` — it is no longer, itself, a 409 the caller reads,
 * because by the time this can be discovered the response admitting the run has already gone
 * out.
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
 * ## `baseOf`, before the draft row exists — and the edit it can still miss
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
 *
 * That catch-all does not reach one particular gap, though: a coach proposal is written against
 * whatever the note or rule said the moment the coach answered, not the moment the draft is
 * made — an owner can read the coach's suggestion, edit the row themselves in the meantime, and
 * only then click «В черновик». `config_version` cannot catch this, because the edit happens
 * *before* the draft (and so before its own version check) exists at all — the gate never sees
 * anything stale to refuse. `POST …/coach/messages/:id/draft` closes it directly: it compares
 * the row's current `updatedAt` (already sitting in `base`, the same read `baseOf` always does)
 * against `coach_messages.createdAt` — the instant the proposal was written — and answers a
 * Russian 409 the moment the row moved after that instant, before the draft is ever written.
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
import { releaseTurnSlot, takeTurnSlotWaiting, turnSlotAvailable } from '../db/turn-cap.js';
import type { Env } from '../env.js';
import type { CoachProposal } from '../lib/ai/coach.js';
import { addCost } from '../lib/ai/turn.js';
import { baselineResults } from '../lib/drafts/baseline.js';
import { baseOf, MissingDraftRowError, type DraftBase, type DraftOp } from '../lib/drafts/ops.js';
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

/**
 * Which drafts have a run in flight right now, in this process.
 *
 * A plain module-level `Set`, the same shape `db/turn-cap.ts`'s own counter takes and for the
 * same reason: there is exactly one process in production, so this needs no more than that to
 * be correct, and a second `registerDraftRoutes` call sharing it (as every test file's rebuilt
 * `app` does across that file's own tests) is the same "belongs to the process, not to one
 * server instance" reasoning `turnsInFlight` already rests on. An entry is added synchronously
 * by the request that admits a run and removed once that run's own detached replay finishes —
 * not once the request that started it answers, which happens first — so nothing here outlives
 * the *run*, even though it outlives the request that opened it. See the run route below.
 */
const runningDrafts = new Set<string>();

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

/** A `CaseSide` plus who paid for it, this time — never a stored column, only ever attached at
 * the moment a response is built. `'paid'` on «стало» always: the draft side is never reused.
 * On «было» it is `'paid'` exactly when *this* call is what wrote the row (nothing cached
 * existed yet) and `'reused'` when an existing baseline answered it instead — so a client can
 * tell a fresh baseline from a cached one instead of guessing from the cost totals alone. */
interface CaseSideOut extends CaseSide {
  origin: 'paid' | 'reused';
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

/** The Russian 409 for a draft op naming a note or rule that is gone — see the file comment's
 * "A deleted note or rule, named by a draft". `draft.base`'s own `noteNames`/`ruleNames` still
 * holds the last name this row had, the same photograph `staleOps` reads for the same reason;
 * a row this draft never actually touched (so `base` never photographed it) falls back to a
 * generic label rather than an empty one. */
function missingRowMessage(error: MissingDraftRowError, base: DraftBase): string {
  const name = error.kind === 'note' ? base.noteNames?.[error.id] : base.ruleNames?.[error.id];
  const label = error.kind === 'note' ? 'Заметка' : 'Правило';
  return `${name ? `«${name}»` : label} была удалена с тех пор, как сделан черновик — обновите его и повторите`;
}

/**
 * Marks every run this process finds still `running` at boot as `failed` — see the file
 * comment's "A restart, and the `running` row it leaves behind".
 *
 * Deliberately **not** wired to a Fastify `onReady` hook inside `registerDraftRoutes`: a test
 * builds a server the same way production does, but many of them (`health.test.ts`,
 * `not-found.test.ts`) do it against a `db` that never actually connects — `createDb` is lazy,
 * and those tests' whole point is answering without touching Postgres. A hook that ran on
 * every `app.ready()` would query on their behalf too, and fail them for a reason that has
 * nothing to do with what they test. `index.ts` calls this once, explicitly, before
 * `app.listen()` — the one place `buildServer` is not also stood up by a test — the same
 * reasoning that keeps the CAPI drain's own timer out of `buildServer` and in that file
 * instead (see its own comment).
 */
export async function reconcileOrphanedRuns(db: Db): Promise<void> {
  await db
    .update(testRuns)
    .set({ status: 'failed', finishedAt: new Date() })
    .where(eq(testRuns.status, 'running'));
}

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

  /**
   * Everything a run does after `POST …/drafts/:draftId/runs` has already answered — see the
   * file comment's "The run is asynchronous". Runs detached, behind the response, the same
   * loop this route used to await before replying: «стало» always paid, «было» read back or
   * paid once, one `test_results` row per side per case, `test_runs` marked `done` or `failed`
   * on the way out. The one thing that changes is where an error that escapes the loop goes:
   * nowhere a caller can read any more, only into a log and the run's own `status`.
   */
  async function runReplay(input: {
    agentId: string;
    numberId: string;
    draft: typeof kbDrafts.$inferSelect;
    casesById: Map<string, { id: string; messages: string[]; enabled: boolean }>;
    runIds: string[];
    existingBaselines: Map<string, typeof testResults.$inferSelect>;
    draftRun: typeof testRuns.$inferSelect;
    baselineRun: typeof testRuns.$inferSelect | null;
  }): Promise<void> {
    const { agentId, numberId, draft, casesById, runIds, existingBaselines, draftRun, baselineRun } = input;

    /** Takes a slot for exactly one `replayCase` call and gives it back immediately after —
     * see the file comment for why per-call, not per-case or per-run, and why this waits
     * rather than throws now that the run is admitted. */
    async function replayOneSide(ops: DraftOp[], messages: string[]): Promise<ReplayResult> {
      const acquired = await takeTurnSlotWaiting();
      if (!acquired) {
        throw new ApiError(503, 'Модель не отвечает слишком долго — прогон прерван, попробуйте ещё раз');
      }
      try {
        return await replayCase(db, deps, { agentId, numberId, key, messages, ops });
      } finally {
        releaseTurnSlot();
      }
    }

    let draftCost = '0';
    let baselineCost = '0';
    // How many baseline rows this run itself wrote — not merely attempted. Decides the
    // baseline run's own final status on the way out; see the file comment on `failed`.
    let baselineWritten = 0;

    try {
      for (const caseId of runIds) {
        const kase = casesById.get(caseId)!;

        // «Стало» — always paid, every case, every run.
        const after = await replayOneSide(draft.ops, kase.messages);
        draftCost = addCost(draftCost, after.cost);
        await db.insert(testResults).values(resultRow(draftRun.id, caseId, sideFromReplay(after)));

        // «Было» — read back when a baseline already exists at this version and model, paid
        // for and stored as one only when it does not.
        if (!existingBaselines.has(caseId)) {
          const baseline = await replayOneSide([], kase.messages);
          baselineCost = addCost(baselineCost, baseline.cost);
          await db.insert(testResults).values(resultRow(baselineRun!.id, caseId, sideFromReplay(baseline)));
          baselineWritten += 1;
        }
      }

      await db
        .update(testRuns)
        .set({ status: 'done', cost: draftCost, finishedAt: new Date() })
        .where(eq(testRuns.id, draftRun.id));
      if (baselineRun) {
        await db
          .update(testRuns)
          .set({ status: 'done', cost: baselineCost, finishedAt: new Date() })
          .where(eq(testRuns.id, baselineRun.id));
      }
    } catch (error) {
      // The run could not finish — the wait for a slot ran out, or something below
      // `replayCase` broke outright, or (see "A deleted note or rule" above) a draft op named a
      // row that is gone. Whatever `test_results` rows already landed stay; the run itself is
      // marked so nothing later mistakes it for a complete answer, and the error goes to the
      // log — see the file comment's "An error has nowhere left to answer to".
      await db
        .update(testRuns)
        .set({ status: 'failed', cost: draftCost, finishedAt: new Date() })
        .where(eq(testRuns.id, draftRun.id));
      if (baselineRun) {
        // `done` the moment at least one result landed — see the file comment on what `failed`
        // means for a baseline run versus a draft-side one.
        await db
          .update(testRuns)
          .set({ status: baselineWritten > 0 ? 'done' : 'failed', cost: baselineCost, finishedAt: new Date() })
          .where(eq(testRuns.id, baselineRun.id));
      }
      const detail = error instanceof MissingDraftRowError ? missingRowMessage(error, draft.base) : undefined;
      app.log.error({ error, runId: draftRun.id, detail }, 'draft run: replay failed');
    }
  }

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

      // A run is expensive and shows no progress — precisely the shape of request a double
      // click repeats. Refused before the body is even parsed, so a second click never spends
      // what the first click is already spending. See the file comment's "Refusing a run
      // before it costs anything". Not released until the run itself is over, not merely once
      // this request answers — see "The run is asynchronous" above.
      if (runningDrafts.has(draft.id)) {
        throw new ApiError(409, 'Этот черновик уже проверяется — дождитесь окончания прогона');
      }
      runningDrafts.add(draft.id);

      // Released here only on an early throw below, before the run is ever admitted; once
      // admitted, the detached replay's own `finally` takes over instead — see below.
      let admitted = false;
      try {
        const parsed = runBody.safeParse(req.body);
        if (!parsed.success) throw new ApiError(400, 'Не удалось разобрать список случаев');
        // Deduplicated before the count is checked against the limit or a row is written: a
        // repeated id is one case to run, not two, and left alone it would trip `test_results`'
        // own `(run_id, case_id)` uniqueness on the second write and fail the whole run for a
        // client mistake this route can just as easily not make in the first place.
        const caseIds = [...new Set(parsed.data.caseIds)];

        if (caseIds.length === 0) {
          throw new ApiError(400, 'Нужен хотя бы один случай для прогона');
        }
        if (caseIds.length > MAX_CASES) {
          throw new ApiError(400, 'За один прогон можно проверить не больше двадцати случаев');
        }
        // A malformed id is exactly as absent as one that does not exist — comparing it against
        // a uuid column would make Postgres raise instead of this route answering 404 (`uuid.ts`).
        if (caseIds.some((id) => !isUuid(id))) throw new ApiError(404, 'Случай не найден');

        const caseRows = await db
          .select({ id: testCases.id, messages: testCases.messages, enabled: testCases.enabled })
          .from(testCases)
          .where(and(eq(testCases.agentId, agentId), inArray(testCases.id, caseIds)));
        const casesById = new Map(caseRows.map((row) => [row.id, row]));
        if (casesById.size !== caseIds.length) throw new ApiError(404, 'Случай не найден');

        // A disabled case stays named in the request but is not run — see the file comment.
        const runIds = caseIds.filter((id) => casesById.get(id)!.enabled);
        if (runIds.length === 0) {
          throw new ApiError(400, 'Все выбранные случаи отключены — включите хотя бы один');
        }

        // Resolved before any bookkeeping row is written: a run refused for want of a number
        // should leave no trace of a run that never started.
        const numberId = await ownNumber(agentId);

        const configVersion = req.agent!.configVersion;
        const model = req.agent!.model;
        const existingBaselines = await baselineResults(db, agentId, runIds, configVersion, model);
        const needsBaseline = runIds.filter((id) => !existingBaselines.has(id));

        // The run-level admission check — see the file comment's "The turn-cap slot". A peek,
        // not a reservation: the real, per-call reservation happens inside `runReplay`, once
        // the run is admitted and committed to finishing.
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

        // Everything from here runs behind the response already on its way out — see the file
        // comment's "The run is asynchronous". `setImmediate` rather than a bare `void`: the
        // same way `whatsapp-webhook.ts` queues its own post-response work, so this handler's
        // own `return` stays the last thing it does, before Node hands the response to the
        // socket.
        setImmediate(() => {
          void runReplay({
            agentId,
            numberId,
            draft,
            casesById,
            runIds,
            existingBaselines,
            draftRun: draftRun!,
            baselineRun,
          }).finally(() => {
            runningDrafts.delete(draft.id);
          });
        });

        return {
          id: draftRun!.id,
          draftId: draft.id,
          status: 'running' as const,
          draftCost: '0',
          baselineCost: '0',
        };
      } finally {
        if (!admitted) runningDrafts.delete(draft.id);
      }
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
      // Paired the same way the POST that made this run did — a reload must not show «стало»
      // with nothing beside it. `baselineResults` always answers with the *newest* done
      // baseline at this run's own `configVersion`/`model`, which is exactly what «было» meant
      // at the time this run was scored (and, if a later run has since refreshed it, the
      // freshest known answer at that same version — still the right thing to show).
      const caseIds = rows.map((row) => row.caseId);
      const baselines = await baselineResults(db, agentId, caseIds, run.configVersion, run.model);

      const results = rows.map((row) => {
        const baseline = baselines.get(row.caseId);
        return {
          caseId: row.caseId,
          // `'reused'`: nothing is computed live by a `GET` — it only ever reads what is
          // already there, whether or not this exact request is what originally paid for it.
          before: baseline ? { ...sideFromRow(baseline), origin: 'reused' as const } : null,
          after: { ...sideFromRow(row), origin: 'paid' as const },
        };
      });

      return {
        id: run.id,
        draftId: run.draftId,
        configVersion: run.configVersion,
        model: run.model,
        status: run.status as 'running' | 'done' | 'failed',
        draftCost: run.cost,
        startedAt: run.startedAt.toISOString(),
        finishedAt: run.finishedAt === null ? null : run.finishedAt.toISOString(),
        results,
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

      // The row the proposal touches, if it edits one, may have moved since the coach wrote
      // the proposal against it — see the file comment's closing section. Only an update op
      // has anything to compare: a create op names no existing row.
      const touchedAt =
        op.op === 'note_update' ? base.notes?.[op.noteId] : op.op === 'rule_update' ? base.rules?.[op.ruleId] : undefined;
      if (touchedAt !== undefined && new Date(touchedAt) > message.createdAt) {
        const label = op.op === 'note_update' ? 'Заметка изменилась' : 'Правило изменилось';
        throw new ApiError(409, `${label} с тех пор, как это предложил коуч — задайте вопрос коучу заново`);
      }

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
