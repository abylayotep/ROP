import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '../../src/db/client.js';
import { kaspiPayments, orders } from '../../src/db/schema.js';

/** Seed a provider-confirmed ledger fact without making an external payment request. */
export async function confirmKaspiOrder(db: Db, orderId: string) {
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
  if (!order) throw new Error('Test order is missing');
  const confirmedAt = order.paidAt ?? new Date();
  await db.update(orders).set({ status: 'paid', paidAt: confirmedAt }).where(eq(orders.id, orderId));
  await db.insert(kaspiPayments).values({
    agentId: order.agentId, conversationId: order.conversationId, orderId,
    requestKey: `fixture:${orderId}`, operationId: `provider:${randomUUID()}`,
    method: 'invoice', phone: '77011234567', amount: order.amount,
    status: 'paid', confirmedAt,
  }).onConflictDoNothing({ target: kaspiPayments.orderId });
}

/** Preserve exact historical amounts/currencies while supplying their verification records. */
export async function seedOrders(db: Db, values: typeof orders.$inferInsert | (typeof orders.$inferInsert)[]) {
  const rows = await db.insert(orders).values(Array.isArray(values) ? values : [values]).returning();
  for (const row of rows) if (row.status === 'paid') await confirmKaspiOrder(db, row.id);
  return rows;
}
