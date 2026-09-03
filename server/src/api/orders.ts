import type { Lead } from '@rakurs/contract';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { orders } from '../db/schema.js';
import { queuePurchase } from '../lib/capi/enqueue.js';
import { ApiError } from '../lib/errors.js';
import { isUuid } from '../lib/uuid.js';
import { loadLead } from './leads.js';
import { requireAgent } from './require-agent.js';

const STATUSES = ['pending', 'paid', 'cancelled'] as const;

/**
 * Up to twelve digits before the point and at most two after — the shape of
 * `numeric(14,2)`.
 *
 * Matched rather than parsed on purpose: `parseFloat` happily accepts `1e5`, `Infinity`
 * and `0x10`, and every one of those would reach the column as an amount nobody typed.
 */
const AMOUNT = /^\d{1,12}(\.\d{1,2})?$/;

const amount = z.string().trim().regex(AMOUNT);

/** A comment is one operator's line about a purchase, not a document. */
const COMMENT_LIMIT = 500;

const comment = z.string().trim().max(COMMENT_LIMIT);

const createOrder = z.object({
  amount,
  status: z.enum(STATUSES).default('pending'),
  comment: comment.default(''),
});

const patchOrder = z.object({
  amount: amount.optional(),
  status: z.enum(STATUSES).optional(),
  comment: comment.optional(),
});

/**
 * The message for the field that actually failed.
 *
 * One message for the whole body would tell someone who sent an unknown status to go and
 * fix the amount, which is the one part of their request that was fine.
 */
function orderError(issue: { code: string; path: readonly PropertyKey[] } | undefined): ApiError {
  const field = issue?.path[0];
  if (field === 'amount') {
    return new ApiError(400, 'Укажите сумму: только цифры, максимум две после точки');
  }
  if (field === 'comment' && issue?.code === 'too_big') {
    return new ApiError(400, `Комментарий длиннее ${COMMENT_LIMIT} символов`);
  }
  return new ApiError(400, 'Не удалось разобрать заказ');
}

export function registerOrderRoutes(
  app: FastifyInstance,
  db: Db,
  guard: preHandlerHookHandler,
): void {
  // Any member: recording what a customer paid is the job, not an administrative act.
  const anyMember = requireAgent(db);

  /** The agent's order, or a 404 that tells a stranger nothing. */
  async function loadOrder(agentId: string, orderId: string) {
    if (!isUuid(orderId)) throw new ApiError(404, 'Заказ не найден');
    const [row] = await db
      .select()
      .from(orders)
      .where(and(eq(orders.id, orderId), eq(orders.agentId, agentId)));
    if (!row) throw new ApiError(404, 'Заказ не найден');
    return row;
  }

  app.post(
    '/api/agents/:agentId/conversations/:conversationId/orders',
    { preHandler: [guard, anyMember] },
    async (req): Promise<Lead> => {
      const { conversationId } = req.params as { conversationId: string };
      const parsed = createOrder.safeParse(req.body);
      if (!parsed.success) throw orderError(parsed.error.issues[0]);

      // Proves the conversation belongs to this agent before anything is written.
      await loadLead(db, req.agent!, conversationId);

      const [created] = await db
        .insert(orders)
        .values({
          agentId: req.agent!.id,
          conversationId,
          amount: parsed.data.amount,
          // Taken from the agent, never from the request: one business, one currency, and a
          // per-order choice would make every total a question about which rows it summed.
          currency: req.agent!.currency,
          status: parsed.data.status,
          comment: parsed.data.comment,
          paidAt: parsed.data.status === 'paid' ? new Date() : null,
        })
        .returning({ id: orders.id });

      // An order recorded as paid became paid here, and it is the commonest way a sale is
      // entered: an operator writes it down after the money has arrived, never passing
      // through `pending` at all. Reporting only the PATCH would leave most sales unreported.
      if (parsed.data.status === 'paid' && created) {
        await queuePurchase(db, { agentId: req.agent!.id, orderId: created.id });
      }
      return loadLead(db, req.agent!, conversationId);
    },
  );

  app.patch(
    '/api/agents/:agentId/orders/:orderId',
    { preHandler: [guard, anyMember] },
    async (req): Promise<Lead> => {
      const { orderId } = req.params as { orderId: string };
      const current = await loadOrder(req.agent!.id, orderId);

      const parsed = patchOrder.safeParse(req.body);
      if (!parsed.success) throw orderError(parsed.error.issues[0]);

      if (Object.keys(parsed.data).length > 0) {
        const patch: Partial<typeof orders.$inferInsert> = { ...parsed.data };

        // Only a real change of status touches the stamp: an edit to the comment of a paid
        // order leaves this branch untaken, which is what keeps the original payment time.
        if (parsed.data.status !== undefined && parsed.data.status !== current.status) {
          // Stage 6 reports `paidAt` as the moment of the purchase, so an order that leaves
          // `paid` for any other status must not keep one. The `??` is defence only — every
          // exit from `paid` nulls the column, so an order arriving back at it has none.
          patch.paidAt = parsed.data.status === 'paid' ? (current.paidAt ?? new Date()) : null;
        }

        await db
          .update(orders)
          .set(patch)
          .where(and(eq(orders.id, current.id), eq(orders.agentId, req.agent!.id)));

        // Became paid, rather than was saved while paid: the comparison against the row read
        // above is the whole difference between one report and one per edit of the comment.
        if (parsed.data.status === 'paid' && current.status !== 'paid') {
          await queuePurchase(db, { agentId: req.agent!.id, orderId: current.id });
        }
      }
      return loadLead(db, req.agent!, current.conversationId);
    },
  );

  app.delete(
    '/api/agents/:agentId/orders/:orderId',
    { preHandler: [guard, anyMember] },
    async (req): Promise<Lead> => {
      const { orderId } = req.params as { orderId: string };
      const current = await loadOrder(req.agent!.id, orderId);

      await db
        .delete(orders)
        .where(and(eq(orders.id, current.id), eq(orders.agentId, req.agent!.id)));
      return loadLead(db, req.agent!, current.conversationId);
    },
  );
}
