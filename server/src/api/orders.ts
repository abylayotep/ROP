import type { Lead } from '@rakurs/contract';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { contacts, conversations, kaspiPayments, orders } from '../db/schema.js';
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
  // Account members may edit notes; only the provider confirms money received.
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

  app.get('/api/agents/:agentId/orders', { preHandler: [guard, anyMember] }, async (req) => {
    const rows = await db.select({ order: orders, contactName: contacts.name, contactPhone: contacts.phone, operationId: kaspiPayments.operationId })
      .from(orders).innerJoin(kaspiPayments, eq(kaspiPayments.orderId, orders.id))
      .innerJoin(conversations, eq(conversations.id, orders.conversationId))
      .innerJoin(contacts, eq(contacts.id, conversations.contactId))
      .where(and(eq(orders.agentId, req.agent!.id), eq(orders.status, 'paid'), eq(kaspiPayments.status, 'paid')))
      .orderBy(desc(orders.paidAt)).limit(500);
    return { orders: rows.map(({ order, ...rest }) => ({ ...order, ...rest, paidAt: order.paidAt?.toISOString() ?? null, createdAt: order.createdAt.toISOString() })) };
  });

  app.post(
    '/api/agents/:agentId/conversations/:conversationId/orders',
    { preHandler: [guard, anyMember] },
    async (req): Promise<Lead> => {
      const { conversationId } = req.params as { conversationId: string };
      const parsed = createOrder.safeParse(req.body);
      if (!parsed.success) throw orderError(parsed.error.issues[0]);

      if (parsed.data.status === 'paid') throw new ApiError(409, 'Оплата подтверждается только Kaspi');

      // Proves the conversation belongs to this agent before anything is written.
      await loadLead(db, req.agent!, conversationId);

      await db
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
          paidAt: null,
        })
        .returning({ id: orders.id });

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

      if (parsed.data.status === 'paid') throw new ApiError(409, 'Оплата подтверждается только Kaspi');
      const [payment] = await db.select().from(kaspiPayments).where(eq(kaspiPayments.orderId, orderId));
      if ((payment || current.status === 'paid') && (parsed.data.amount !== undefined || parsed.data.status !== undefined)) throw new ApiError(409, 'Сумма и статус платёжного заказа неизменяемы');

      if (Object.keys(parsed.data).length > 0) {
        const patch: Partial<typeof orders.$inferInsert> = { ...parsed.data };

        await db
          .update(orders)
          .set(patch)
          .where(and(eq(orders.id, current.id), eq(orders.agentId, req.agent!.id)));


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

      const [payment] = await db.select().from(kaspiPayments).where(eq(kaspiPayments.orderId, orderId));
      if (payment || current.status === 'paid') throw new ApiError(409, 'Платёжный заказ нельзя удалить');
      await db
        .delete(orders)
        .where(and(eq(orders.id, current.id), eq(orders.agentId, req.agent!.id)));
      return loadLead(db, req.agent!, current.conversationId);
    },
  );
}
