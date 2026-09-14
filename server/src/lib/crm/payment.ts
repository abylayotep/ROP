import { and, desc, eq, or, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { crmAnalyses, orders, stages, stageTransitions } from '../../db/schema.js';
import type { Executor } from '../funnel.js';
import { hasConfirmedKaspiPayment } from '../kaspi/service.js';

/**
 * True when an operator undid a sale: the lead's latest move into or out of the sale stage
 * is an operator taking it out.
 *
 * Only moves that touch the sale stage count, so the AI moving the lead between other
 * stages afterwards does not erase the undo, and an operator putting it back does. A move
 * out of a sale stage that has since been deleted cannot be recognised and does not count.
 */
export async function operatorLeftSale(db: Executor, conversationId: string): Promise<boolean> {
  const [latest] = await db.select({ movedBy: stageTransitions.movedBy, toKind: stageTransitions.toKind })
    .from(stageTransitions)
    .leftJoin(stages, eq(stages.id, stageTransitions.fromStageId))
    .where(and(eq(stageTransitions.conversationId, conversationId),
      or(eq(stageTransitions.toKind, 'success'), eq(stages.kind, 'success'))))
    .orderBy(desc(stageTransitions.occurredAt), desc(stageTransitions.id)).limit(1);
  return latest?.movedBy === 'operator' && latest.toKind !== 'success';
}

/**
 * Money a lead may be moved into the sale stage on: Kaspi confirmed it, or the stored analysis
 * saw it, no order has been paid yet and no operator has since taken the lead out of the sale
 * stage. The stored claim is not tied to a message, so once a sale is recorded it may be that
 * sale's; a repeat purchase in the chat is moved by the CRM worker, which checks message dates.
 */
export async function hasVisiblePayment(db: Db, agentId: string, conversationId: string): Promise<boolean> {
  if (await hasConfirmedKaspiPayment(db, agentId, conversationId)) return true;
  return chatPaymentSeen(db, conversationId);
}

/** The chat half of `hasVisiblePayment`: the stored analysis saw money and no sale has used it. */
export async function chatPaymentSeen(db: Db, conversationId: string): Promise<boolean> {
  const [row] = await db.select({ profile: crmAnalyses.profile }).from(crmAnalyses).where(eq(crmAnalyses.conversationId, conversationId));
  const seen = row?.profile.paymentEvidence === 'paid' || row?.profile.paymentEvidence === 'confirmed';
  if (!seen) return false;
  const [paid] = await db.select({ id: orders.id }).from(orders)
    .where(and(eq(orders.conversationId, conversationId), eq(orders.status, 'paid'))).limit(1);
  return !paid && !await operatorLeftSale(db, conversationId);
}

/**
 * Whether the sales script may treat the current sale as paid, and the paid orders that say so.
 *
 * «The current sale» is everything since the conversation entered the script for this purchase
 * (`conversations.script_started_at`): an order paid — or recorded, for a chat order backdated to
 * when the lead entered the sale stage — no earlier than that. Kaspi money is always an order, so
 * it is covered by the same read. Without an order the chat half of `hasVisiblePayment` still
 * counts, since it only ever covers a first sale.
 *
 * A conversation that has not entered the script yet is never paid. The stage-based reads
 * (`hasPaidOrderInSaleEpisode`, `hasConfirmedKaspiPayment`) cannot tell a repeat customer's old
 * sale from this one while the lead still stands in the sale stage, and answering «paid» wrongly
 * sends the finished product before the money; answering «not yet» for one turn only waits.
 */
export async function scriptPayment(
  db: Db,
  conversation: { id: string; scriptStartedAt: Date | null },
): Promise<{ paid: boolean; orderIds: string[] }> {
  if (conversation.scriptStartedAt === null) return { paid: false, orderIds: [] };
  const rows = await db.select({ id: orders.id }).from(orders)
    .where(and(eq(orders.conversationId, conversation.id), eq(orders.status, 'paid'),
      sql`greatest(${orders.paidAt}, ${orders.createdAt}) >= ${conversation.scriptStartedAt.toISOString()}::timestamptz`));
  const orderIds = rows.map((row) => row.id);
  return { paid: orderIds.length > 0 || await chatPaymentSeen(db, conversation.id), orderIds };
}
