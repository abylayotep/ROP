/**
 * The record that a lead moved: one append-only row per move, written by whoever moved it.
 *
 * `conversations.stage_id` says where a lead stands now and nothing about where it has
 * been. This table is the only thing that can answer «сколько лидов дошло до счёта», and
 * there is nothing to reconstruct it from after the fact — so it starts at
 * `agents.stage_history_since` and every mover writes to it from that day on.
 */
import { stageTransitions } from '../db/schema.js';
import type { Executor } from './funnel.js';

/** Who moved the lead. `operator` is the only one that also carries a user. */
export type MovedBy = 'operator' | 'ai' | 'scenario' | 'system';

/**
 * Appends one transition.
 *
 * **Takes an `Executor` and never opens its own transaction.** It has to land or fail
 * together with the `UPDATE` that moved the stage: a row here about a move that rolled
 * back is a lead counted in a stage it never entered.
 *
 * **No try/catch, on purpose, and deliberately unlike its neighbours.** `queueLead` in
 * `lib/capi/enqueue.ts` and `sendStageMessage` in `lib/funnel-message.ts` swallow
 * everything they hit, because they are reports to somebody else's system over the
 * network and the operator's action has already happened — a failed consequence must not
 * undo its cause. This one is not a consequence, it is the record of the cause: it is a
 * single insert into our own table inside a transaction already open, so the only way it
 * fails is a database that is broken, in which case the move was doomed anyway. A history
 * with silent gaps produces conversion numbers that are wrong and unfalsifiable — the one
 * failure mode a statistics screen must not have.
 *
 * Both stages are snapshotted by name as well as by id. An owner may delete a stage that
 * leads passed through, and `on delete set null` alone would erase which stage it was.
 *
 * `occurredAt` is left to the column default so the row is stamped by the statement that
 * writes it, rather than by a `new Date()` the caller made earlier in the request.
 */
export async function recordStageMove(
  db: Executor,
  input: {
    agentId: string;
    conversationId: string;
    /** Null exactly when this is the first stage the lead was ever given. */
    from: { id: string; name: string; position: number } | null;
    to: { id: string; name: string; kind: string; position: number };
    movedBy: MovedBy;
    movedByUserId?: string | null;
  },
): Promise<void> {
  await db.insert(stageTransitions).values({
    agentId: input.agentId,
    conversationId: input.conversationId,
    fromStageId: input.from?.id ?? null,
    fromName: input.from?.name ?? null,
    fromPosition: input.from?.position ?? null,
    toStageId: input.to.id,
    toName: input.to.name,
    toKind: input.to.kind,
    toPosition: input.to.position,
    movedBy: input.movedBy,
    movedByUserId: input.movedByUserId ?? null,
  });
}
