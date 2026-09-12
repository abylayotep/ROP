import { and, eq, inArray, asc, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { agents, conversations, kaspiPayments, kaspiSessions, orders, stages } from '../../db/schema.js';
import type { Env } from '../../env.js';
import { recordStageMove } from '../funnel-history.js';
import { ApiError } from '../errors.js';
import { credentialsKey, decryptSecret } from '../secret-box.js';
import { queuePurchase } from '../capi/enqueue.js';
import { KaspiClient, normalisePhone, operationId, paymentOutcome, validateAmount, type KaspiSession } from './client.js';
export const sessionAad = (agentId: string) => `kaspi:${agentId}`;
export function kaspiClient(env: Env) {
  if (!env.KASPI_POS_URL) throw new ApiError(503, 'Kaspi POS ещё не настроен на сервере');
  return new KaspiClient(env.KASPI_POS_URL);
}
export async function activeSession(db: Db, env: Env, agentId: string): Promise<KaspiSession> {
  const [row] = await db.select().from(kaspiSessions).where(eq(kaspiSessions.agentId, agentId));
  if (!row?.credentials) throw new ApiError(409, 'Подключите Kaspi POS в интеграциях');
  return JSON.parse(decryptSecret(row.credentials, credentialsKey(env), sessionAad(agentId))) as KaspiSession;
}
export function paymentDto(row: typeof kaspiPayments.$inferSelect) {
  return { id: row.id, orderId: row.orderId, conversationId: row.conversationId, method: row.method, phone: row.phone, amount: row.amount, status: row.status, operationId: row.operationId, qrToken: row.qrToken, paymentUrl: row.paymentUrl, error: row.error ?? (row.notificationStatus === 'unknown' ? 'Доставка сообщения об оплате не подтверждена. Проверьте переписку перед повторной отправкой.' : null), confirmedAt: row.confirmedAt?.toISOString() ?? null };
}
export async function createKaspiCheckout(db: Db, env: Env, input: { agentId: string; conversationId: string; amount: string; phone: string; method?: 'invoice' | 'qr'; requestKey: string; comment?: string }) {
  const amount = validateAmount(input.amount);
  const method = input.method ?? 'invoice';
  const phone = method === 'invoice' ? normalisePhone(input.phone) : '';
  const client = kaspiClient(env);
  const session = await activeSession(db, env, input.agentId);
  const [existingRequest] = await db.select().from(kaspiPayments).where(and(eq(kaspiPayments.agentId, input.agentId), eq(kaspiPayments.requestKey, input.requestKey)));
  if (existingRequest) {
    if (existingRequest.conversationId !== input.conversationId || Number(existingRequest.amount) !== Number(amount) || existingRequest.method !== method || existingRequest.phone !== phone) throw new ApiError(409, 'Этот запрос уже использован для другого счёта');
    return paymentDto(existingRequest);
  }
  if (method === 'qr') {
    const [open] = await db.select().from(kaspiPayments).where(and(eq(kaspiPayments.agentId, input.agentId), eq(kaspiPayments.conversationId, input.conversationId), eq(kaspiPayments.status, 'pending')));
    if (open?.method === 'invoice' && open.operationId && Number(open.amount) === Number(amount)) {
      // A cancellation acknowledgement alone is insufficient: read the actual terminal status.
      await client.request('POST', '/api/invoice/cancel', { operationId: open.operationId }, session);
      const cancelled = await reconcileKaspiPayment(db, env, input.agentId, open.id);
      if (cancelled.status !== 'failed' && cancelled.status !== 'expired') throw new ApiError(409, 'Kaspi ещё не подтвердил отмену счёта. QR не создан');
    }
  }
  const intent = await db.transaction(async (tx) => {
    // The conversation lock serializes different request keys as well as retransmissions.
    const [conversation] = await tx.select().from(conversations).where(and(eq(conversations.id, input.conversationId), eq(conversations.agentId, input.agentId))).for('update');
    if (!conversation) throw new ApiError(404, 'Диалог не найден');
    const [prior] = await tx.select().from(kaspiPayments).where(and(eq(kaspiPayments.agentId, input.agentId), eq(kaspiPayments.requestKey, input.requestKey)));
    if (prior) {
      if (prior.conversationId !== input.conversationId || Number(prior.amount) !== Number(amount) || prior.method !== method || prior.phone !== phone) throw new ApiError(409, 'Этот запрос уже использован для другого счёта');
      return { row: prior, fresh: false };
    }
    const [open] = await tx.select().from(kaspiPayments).where(and(eq(kaspiPayments.conversationId, input.conversationId), inArray(kaspiPayments.status, ['creating', 'unknown', 'pending'])));
    if (open) throw new ApiError(409, 'В этом диалоге уже есть незавершённый счёт. Проверьте его статус');
    const [agent] = await tx.select().from(agents).where(eq(agents.id, input.agentId));
    if (agent?.currency !== 'KZT') throw new ApiError(400, 'Kaspi принимает оплату только в тенге');
    const [order] = await tx.insert(orders).values({ agentId: input.agentId, conversationId: input.conversationId, amount, currency: 'KZT', comment: input.comment ?? '' }).returning();
    const [row] = await tx.insert(kaspiPayments).values({ agentId: input.agentId, conversationId: input.conversationId, orderId: order!.id, requestKey: input.requestKey, method, phone, amount }).returning();
    return { row: row!, fresh: true };
  });
  if (!intent.fresh) return paymentDto(intent.row);
  try {
    const response = await client.create(method, session, amount, phone, input.comment ?? 'Rakurs');
    const id = operationId(response);
    if (response.StatusCode !== 0 || !id) throw new ApiError(502, 'Kaspi не вернул идентификатор счёта. Не повторяйте запрос до проверки кассы');
    const url = response.Data?.PaymentLink ?? response.Data?.QrPaymentLink ?? response.Data?.QrToken;
    const [saved] = await db.update(kaspiPayments).set({ operationId: id, status: 'pending', qrToken: typeof response.Data?.QrToken === 'string' ? response.Data.QrToken : null, paymentUrl: typeof url === 'string' && /^https:\/\/(?:[\w-]+\.)?kaspi\.kz\//.test(url) ? url : null }).where(eq(kaspiPayments.id, intent.row.id)).returning();
    return paymentDto(saved!);
  } catch (error) {
    if (error instanceof ApiError && error.statusCode === 409) await db.update(kaspiSessions).set({ credentials: null, updatedAt: new Date() }).where(eq(kaspiSessions.agentId, input.agentId));
    const [saved] = await db.update(kaspiPayments).set({ status: 'unknown', error: 'Результат выставления счёта неизвестен. Проверьте кассу Kaspi; повторное выставление заблокировано.' }).where(eq(kaspiPayments.id, intent.row.id)).returning();
    return paymentDto(saved!);
  }
}
export async function reconcileKaspiPayment(db: Db, env: Env, agentId: string, id: string) {
  const [row] = await db.select().from(kaspiPayments).where(and(eq(kaspiPayments.id, id), eq(kaspiPayments.agentId, agentId)));
  if (!row) throw new ApiError(404, 'Счёт не найден');
  if (row.status !== 'pending' || !row.operationId) return paymentDto(row);
  let reply;
  try { reply = await kaspiClient(env).status(row.method, await activeSession(db, env, agentId), row.operationId); }
  catch (error) {
    if (error instanceof ApiError && error.statusCode === 409) await db.update(kaspiSessions).set({ credentials: null, updatedAt: new Date() }).where(eq(kaspiSessions.agentId, agentId));
    throw error;
  }
  const returnedId = operationId(reply);
  if (returnedId && returnedId !== row.operationId) throw new ApiError(502, 'Kaspi вернул другой идентификатор счёта');
  const status = paymentOutcome(reply, row.amount);
  const saved = await db.transaction(async (tx) => {
    const [updated] = await tx.update(kaspiPayments).set({ status, checkedAt: new Date(), confirmedAt: status === 'paid' ? new Date() : null }).where(and(eq(kaspiPayments.id, id), eq(kaspiPayments.status, 'pending'))).returning();
    if (updated && status === 'paid') {
      await tx.update(orders).set({ status: 'paid', paidAt: updated.confirmedAt }).where(eq(orders.id, row.orderId));
      const [conversation] = await tx.select().from(conversations).where(eq(conversations.id, row.conversationId)).for('update');
      const stageRows = await tx.select().from(stages).where(eq(stages.agentId, agentId)).orderBy(asc(stages.position));
      const target = stageRows.find((stage) => stage.kind === 'success');
      if (conversation && target && conversation.stageId !== target.id) {
        await tx.update(conversations).set({ stageId: target.id, stageSetAt: new Date(), stageSetBy: 'system' }).where(eq(conversations.id, conversation.id));
        await recordStageMove(tx, { agentId, conversationId: conversation.id, from: stageRows.find((stage) => stage.id === conversation.stageId) ?? null, to: target, movedBy: 'system' });
      }
    } else if (updated && (status === 'failed' || status === 'expired')) {
      await tx.update(orders).set({ status: 'cancelled', paidAt: null }).where(eq(orders.id, row.orderId));
    }
    return updated ?? row;
  });
  if (status === 'paid') await queuePurchase(db, { agentId, orderId: row.orderId });
  return paymentDto(saved);
}
export async function reconcileKaspiPayments(db: Db, env: Env): Promise<void> {
  if (!env.KASPI_POS_URL) return;
  // Recover abandoned create intents without issuing another external invoice.
  await db.update(kaspiPayments).set({ status: 'unknown', error: 'Ответ Kaspi не сохранён. Проверьте кассу перед дальнейшими действиями.' }).where(and(eq(kaspiPayments.status, 'creating'), sql`${kaspiPayments.createdAt} < now() - interval '2 minutes'`));
  const rows = await db.select().from(kaspiPayments).where(eq(kaspiPayments.status, 'pending')).orderBy(sql`${kaspiPayments.checkedAt} asc nulls first`).limit(50);
  for (const row of rows) {
    try { await reconcileKaspiPayment(db, env, row.agentId, row.id); }
    catch { await db.update(kaspiPayments).set({ checkedAt: new Date() }).where(eq(kaspiPayments.id, row.id)); }
  }
  // Purchase enqueue is idempotent, so a process crash after committing payment is repairable.
  const confirmed = await db.select().from(kaspiPayments).where(eq(kaspiPayments.status, 'paid')).orderBy(asc(kaspiPayments.checkedAt)).limit(50);
  for (const row of confirmed) {
    await queuePurchase(db, { agentId: row.agentId, orderId: row.orderId });
    await db.update(kaspiPayments).set({ checkedAt: new Date() }).where(eq(kaspiPayments.id, row.id));
  }
}

export async function hasConfirmedKaspiPayment(db: Db, agentId: string, conversationId: string): Promise<boolean> {
  const [row] = await db.select({ id: kaspiPayments.id }).from(kaspiPayments)
    .innerJoin(orders, eq(orders.id, kaspiPayments.orderId))
    .where(and(eq(kaspiPayments.agentId, agentId), eq(kaspiPayments.conversationId, conversationId), eq(kaspiPayments.status, 'paid'), eq(orders.status, 'paid'), sql`${kaspiPayments.operationId} is not null`, sql`${kaspiPayments.confirmedAt} is not null`)).limit(1);
  return !!row;
}
