/**
 * Replaying a saved conversation against a draft — and the transaction that makes it safe.
 *
 * A "case" is a customer's side of a conversation, one or more messages, answered in order
 * against the store as it would look with a draft's operations already applied. None of it is
 * real: not the contact, not the conversation, not the operations. All of it lives inside one
 * transaction that is always thrown away, so a run can be as bold as it likes about pretending
 * a customer wrote something and an owner's draft had already landed.
 *
 * This used to be `api/ai.ts`'s own private mechanism for exactly the single-message case —
 * "what would the agent say right now" — and now serves the general one too. A case of several
 * messages is not several calls to this file's machinery, but one: the second question has to
 * be asked with the first one's answer already sitting in the conversation, the way a real
 * customer's second message always is.
 */
import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { contacts, conversations, kbChunks, messages } from '../../db/schema.js';
import { turnSlotHeld } from '../../db/turn-cap.js';
import type { ModelClient } from '../ai/openrouter.js';
import { addCost, runTurn, type TurnOutcome, type TurnResult } from '../ai/turn.js';
import type { GraphClient } from '../whatsapp/graph.js';
import { applyOps, type DraftOp } from './ops.js';
import type { LinkedClient } from '../whatsapp/linked/client.js';

/**
 * What a case needs beyond the store it runs against: the model to call, and the Graph client
 * a turn still reads from even in a dry run — to check a number is enabled and a token still
 * opens, never to send (see `runTurn`'s own comment on `readySend`).
 *
 * Lived in `api/ai.ts` until now, the one caller before this file existed. `replayCase` is the
 * thing that actually spends both fields, so it is the thing this type sits beside — `api/ai.ts`
 * imports it from here rather than the other way around, the same `lib` → `api` direction every
 * other dependency in this module already runs.
 */
export interface AiDeps {
  model: ModelClient;
  graph: GraphClient;
  /** A replay never sends, but a turn's dependencies are a turn's dependencies. */
  linked: LinkedClient;
}

export interface ReplayInput {
  agentId: string;
  numberId: string;
  /** The credentials key, exactly as `TurnDeps` wants it. Handed in rather than read from
   * `env` here, the same way `sandboxTurn` used to take it — a decrypted key lives no longer
   * than the one turn that needs it. */
  key: Buffer;
  /** The customer's side only, in order. The agent's replies are produced here, not supplied —
   * storing them in the input would be storing the answer in the question. */
  messages: string[];
  ops: DraftOp[];
}

/**
 * What replaying a case answers back.
 *
 * `reply` through `cost` are exactly `test_results`' own columns (`db/schema.ts`) — this is
 * the row Task 6 writes, field for field, once per case in a run. Everything but `cost`
 * carries the *last* turn's value: a case is a conversation, and what a person reading a
 * result wants to know is how it ended, not how its first message went. `test_results.outcome`
 * says the same in its own comment — "the `TurnOutcome` the replay **ended in**". `cost` is
 * the odd one out, and deliberately: it is every model call the case actually made added
 * together (see `meteredModel`), because a run's own total is these rows summed, and a
 * multi-message case that only counted its last turn would under-report what it actually
 * spent to every report built on top of it.
 *
 * `fields` and `detail` ride along beyond that shape, for the one caller here that is not
 * Task 6: the sandbox route. Neither is a `test_results` column — a single "what would the
 * agent do right now" turn has no case and no run to save a row against — but both are what
 * `TurnResult` already carried and `POST /api/agents/:id/ai/sandbox` still answers with, and
 * dropping them would cost an owner tuning instructions a real part of what the sandbox shows
 * them, not simplify anything.
 */
export interface ReplayResult {
  /** The last turn's reply to the customer, or null — see `TurnResult.reply`. */
  reply: string | null;
  /** The knowledge chunks the last turn's reply was built from. */
  usedChunkIds: string[];
  /** Indexes into `input.ops` of the draft notes those chunks belong to, deduplicated and
   * ascending. The chunk ids alone cannot say this later: every note an op saves gets fresh
   * chunks that vanish with the rollback. */
  usedOpIndexes: number[];
  /** The stage the last turn moved the lead to, or would have. Null when it did not move. */
  stageId: string | null;
  /** Whether the last turn left the conversation to a person. */
  handoff: boolean;
  /** Why, when `handoff` is true; null otherwise. */
  handoffReason: string | null;
  /** How the last turn ended. */
  outcome: TurnOutcome;
  /** Every turn in the case, added together — not only the last. */
  cost: string;
  /** The lead fields the last turn filled, or would have. Not a `test_results` column — see
   * this type's own comment. */
  fields: Record<string, string>;
  /** Why the last turn ended the way it did, when that is worth telling anyone. Not a
   * `test_results` column — see this type's own comment. */
  detail: string | null;
}

/**
 * A replay's result, carried out of the transaction by the exception that rolls it back.
 *
 * Drizzle rolls a transaction back when its callback throws and rethrows what was thrown, so
 * a throw is both the rollback and the return. Ours rather than `tx.rollback()`, because that
 * one is recognised by an error class this file would then have to import and keep in step
 * with the ORM; a private class cannot be confused with a real failure.
 *
 * Carries the last turn's own `TurnResult` rather than an already-built `ReplayResult`, and
 * the summed cost beside it — the one field that is not simply the last turn's, kept apart so
 * nothing here has to re-derive it from a result it has already thrown away the pieces of.
 *
 * Named `ReplayDone`, not `SandboxDone`: this file is no longer the sandbox's own private
 * mechanism, and the name should say what actually finished.
 */
class ReplayDone extends Error {
  constructor(
    readonly turn: TurnResult,
    readonly cost: string,
    readonly usedOpIndexes: number[],
  ) {
    super('replay finished');
    this.name = 'ReplayDone';
  }
}

/**
 * Wraps a model so every call it actually answers adds its cost to a running total.
 *
 * `TurnResult` carries no cost of its own — `runTurn` only ever spends it, into `spend()` and
 * from there into `ai_replies`, which a dry run never writes, so there is no row and no return
 * value to read a turn's cost back out of. The model call itself is the one place left that
 * knows what each attempt cost, retries included, so this is where the running total is kept.
 *
 * Reads `completion?.cost` rather than `completion.cost`, and never throws on what it reads.
 * `runTurn` calls the model inside its own `try`/`catch` and treats anything thrown there as
 * an ordinary model failure — a wrong key, a timeout — logging it and returning cleanly rather
 * than raising. A malformed completion (no `cost`, or nothing at all) is a bug in the model
 * client itself, one `runTurn` deliberately lets escape uncaught *after* that `catch`, and this
 * wrapper sits *inside* the call `runTurn` guards — so throwing here would recategorise that
 * bug as a model failure instead of letting it surface the way `runTurn` means it to.
 */
function meteredModel(model: ModelClient): { model: ModelClient; total: () => string } {
  let cost = '0';
  return {
    model: {
      complete: async (input) => {
        const completion = await model.complete(input);
        cost = addCost(cost, completion?.cost ?? '0');
        return completion;
      },
    },
    total: () => cost,
  };
}

const toResult = (done: ReplayDone): ReplayResult => ({
  reply: done.turn.reply,
  usedChunkIds: done.turn.usedItemIds,
  usedOpIndexes: done.usedOpIndexes,
  stageId: done.turn.stageId,
  handoff: done.turn.handoff !== null,
  handoffReason: done.turn.handoff,
  outcome: done.turn.outcome,
  cost: done.cost,
  fields: done.turn.fields,
  detail: done.turn.detail,
});

/**
 * Runs a case — one or more customer messages — against a draft, inside a transaction that
 * never commits.
 *
 * `runTurn` reads everything a turn knows from the database and takes no free text, so a case
 * has to be given a conversation to read exactly as `sandboxTurn` used to give it one: a
 * contact, a thread on a real number and the customer's line — inside a transaction that is
 * always rolled back, so every turn sees exactly the shape a real one sees and the cabinet is
 * left as it was found.
 *
 * A transaction rather than «create, then delete afterwards»: a delete in a `finally` leaves
 * rows behind if the process dies mid-run, and the one thing this must never do is put a fake
 * customer into somebody's real inbox. `dryRun` already stops every write `runTurn` makes; the
 * rollback is what covers the rows this function makes to call it with, and it would cover a
 * regression in `dryRun` as well.
 *
 * Ops apply first, before the fake contact and conversation exist. The order between those two
 * steps does not itself matter — `applyOps` only ever touches `kb_notes`, `kb_chunks`,
 * `kb_links` and `agent_rules`, and never reads or writes a contact, a conversation or a
 * message, so the fake conversation this function invents is neither seen by it nor able to
 * see it. What does matter is that both finish before the loop below starts: `runTurn` reads
 * notes and rules fresh out of the database on every turn it runs, and whatever a draft would
 * have changed has to already be sitting there before the first message is answered — inside
 * the same transaction that is about to disappear.
 *
 * A `rule_create` op holds an advisory lock on its category for the rest of the transaction —
 * see `lockCategories` — which here means for the rest of the case, across every message and
 * every model call it makes. Nothing here works around that, and nothing should: `applyOps`
 * has to run before the turns (see above), and the lock it takes has to outlive the write it
 * guards for the same reason any transaction-scoped lock does. It is worth saying plainly
 * because a coaching draft is exactly the kind that carries `rule_create` (`agent-coaching.md`),
 * so this is not a cold path — a concurrent edit to that category blocks for as long as the
 * slowest model call in the case takes.
 *
 * Each message is inserted as an inbound one and answered with `runTurn(..., { dryRun: true })`
 * before the next is. A dry run never writes the reply it produces — `deliver` in `turn.ts`,
 * the one place that write happens, is never reached in a dry run — so this is where the
 * agent's own words become history for whatever the next message in the case asks. Answered
 * as though the first question had never been asked is exactly what a second `runTurn` call
 * would do without this: the reply is inserted as an outbound message before the loop moves
 * on, the same author and kind a real one would carry.
 *
 * A handoff ends the case. `failed` and `skipped` loop on to the next message — a real thread
 * gets another chance to answer on its customer's next message, and a case should show the
 * same recovery a real conversation gets. A handoff is different: `runTurn` skips its own
 * `!dryRun && !conversation.aiEnabled` refusal for exactly this reason (see that file's header
 * comment), so nothing here stops a second dry-run turn from answering right past a handoff a
 * real turn would have ended the thread on — reporting whatever the *last* message did, not
 * the handoff a real customer would never have gotten a reply to. So the loop breaks the
 * instant a turn hands off, and the case's result is that turn's own.
 *
 * The two inserted messages inside one message's turn — inbound, then its own reply — get
 * timestamps from one monotonically increasing counter for the whole case, not `new Date()`
 * called twice. Every insert lands in the same transaction, and Postgres's `now()` — what
 * `transaction_timestamp()` and so `created_at`'s own `defaultNow()` reads — is fixed for the
 * whole transaction, so `created_at` cannot break a tie between two rows inserted here even
 * though `runTurn`'s history query orders by it second. `sentAt` is set in application code
 * and does vary row to row, but only at millisecond resolution — and a case can insert several
 * rows inside one millisecond, so two adjacent messages can tie there too. A real message never
 * has either problem: it lands in its own transaction, with its own `now()`, seconds or minutes
 * apart from its neighbours. Only a replayed case's messages are dense enough, in one
 * transaction, to need a tie-break that cannot fail.
 *
 * The turn is handed the transaction, which is the same query interface under a type Drizzle
 * keeps separate from `Db` — hence the casts. Nothing `runTurn` reaches for in a dry run lives
 * outside it: no `$client`, and the sending path stops before the Graph call.
 *
 * Holds one database connection for as long as every turn in the case takes — the same shape
 * `sandboxTurn` always held for its one turn. That is `db/turn-cap.ts`'s concern, not this
 * function's: the cap is sized against the pool, not against a case, and the caller is the one
 * that knows whether it is running one case or stepping through a run of many. So this function
 * never calls `tryTakeTurnSlot` / `releaseTurnSlot` itself — the sandbox route wraps its one
 * call to this function in exactly the pair it always wrapped `sandboxTurn` in, and a future
 * run route (Task 6) does the same around each case it steps through. Taking the slot *inside*
 * this function, once per turn rather than once per call, would not even track the truth: the
 * transaction holds its connection for the whole case regardless of how the counter is poked,
 * so a per-turn slot would let the bookkeeping claim a connection was freed between messages
 * that the pool never actually gave back. What this function *does* do is assert, at its own
 * top, that some caller somewhere already took the slot it is about to hold for the case's
 * whole duration — see `turnSlotHeld`. That is not a substitute for a caller taking its own
 * slot; it is a caller that forgot failing loudly in a test rather than emptying the pool
 * silently in production.
 */
export async function replayCase(db: Db, deps: AiDeps, input: ReplayInput): Promise<ReplayResult> {
  if (!turnSlotHeld()) {
    throw new Error(
      'replayCase: called with no turn-cap slot held — see tryTakeTurnSlot in db/turn-cap.ts',
    );
  }
  if (input.messages.length === 0) {
    throw new Error('replayCase: a case needs at least one message');
  }

  try {
    await db.transaction(async (tx) => {
      const noteOpIndex = new Map<string, number>();
      await applyOps(tx as unknown as Db, input.agentId, input.ops, (opIndex, noteId) => {
        noteOpIndex.set(noteId, opIndex);
      });

      const [contact] = await tx
        .insert(contacts)
        .values({
          agentId: input.agentId,
          // Unique per agent, and unlike any phone number, so it cannot collide with a real
          // contact even in the instant before the rollback.
          phone: `sandbox-${randomUUID()}`,
          name: 'Песочница',
        })
        .returning();

      const now = new Date();
      const [conversation] = await tx
        .insert(conversations)
        .values({
          agentId: input.agentId,
          contactId: contact!.id,
          whatsappNumberId: input.numberId,
          // The window is checked in a dry run too, and a case that refused because a
          // conversation invented a second ago is stale would be answering nothing.
          lastInboundAt: now,
          lastMessageAt: now,
        })
        .returning();

      // One base instant plus a strictly increasing tick, rather than `new Date()` at each
      // insert — see this function's own comment on why a case's own messages need a tie-break
      // that milliseconds alone cannot give them.
      const base = now.getTime();
      let tick = 0;
      const nextSentAt = (): Date => new Date(base + tick++);

      let turn: TurnResult | null = null;
      // Every call the case makes, across every message and every retry within one — see
      // `meteredModel`'s own comment for why this is read off the model rather than off
      // `TurnResult`.
      const metered = meteredModel(deps.model);

      for (const text of input.messages) {
        await tx.insert(messages).values({
          conversationId: conversation!.id,
          direction: 'in',
          author: 'client',
          kind: 'text',
          body: text,
          sentAt: nextSentAt(),
        });

        turn = await runTurn(
          tx as unknown as Db,
          { model: metered.model, graph: deps.graph, linked: deps.linked, key: input.key },
          { agentId: input.agentId, conversationId: conversation!.id, dryRun: true },
        );

        // A handoff ends the case here — see this function's own comment. Nothing after this
        // message is answered, and the case's result is this turn's.
        if (turn.outcome === 'handoff') break;

        // See this function's own comment: a dry run never writes this itself, and the next
        // iteration's history has to hold it. Nothing to insert when the turn produced no
        // reply — an empty answer leaves nothing for the next message to read.
        if (turn.reply !== null) {
          await tx.insert(messages).values({
            conversationId: conversation!.id,
            direction: 'out',
            author: 'ai',
            kind: 'text',
            body: turn.reply,
            sentAt: nextSentAt(),
          });
        }
      }

      // Resolved here, while the draft's chunks still exist, before the rollback drops them.
      const usedChunkIds = turn!.usedItemIds;
      const cited = usedChunkIds.length === 0 || noteOpIndex.size === 0
        ? []
        : await tx
          .select({ noteId: kbChunks.noteId })
          .from(kbChunks)
          .where(inArray(kbChunks.id, usedChunkIds));
      const usedOpIndexes = [...new Set(cited.flatMap(({ noteId }) => {
        const index = noteOpIndex.get(noteId);
        return index === undefined ? [] : [index];
      }))].sort((a, b) => a - b);

      throw new ReplayDone(turn!, metered.total(), usedOpIndexes);
    });
  } catch (error) {
    if (error instanceof ReplayDone) return toResult(error);
    throw error;
  }
  // The callback above always throws, which the compiler has no way of knowing.
  throw new Error('replay transaction returned without a result');
}
