import { and, desc, eq, or } from 'drizzle-orm';
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
  const [row] = await db.select({ profile: crmAnalyses.profile }).from(crmAnalyses).where(eq(crmAnalyses.conversationId, conversationId));
  const seen = row?.profile.paymentEvidence === 'paid' || row?.profile.paymentEvidence === 'confirmed';
  if (!seen) return false;
  const [paid] = await db.select({ id: orders.id }).from(orders)
    .where(and(eq(orders.conversationId, conversationId), eq(orders.status, 'paid'))).limit(1);
  return !paid && !await operatorLeftSale(db, conversationId);
}
