import { eq } from 'drizzle-orm';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { agents, contacts, conversations, kaspiSessions, kaspiPayments, orders, stages, stageTransitions, whatsappNumbers } from '../src/db/schema.js';
import { createKaspiCheckout, reconcileKaspiPayment, reconcileKaspiPayments, hasConfirmedKaspiPayment, sessionAad } from '../src/lib/kaspi/service.js';
import { encryptSecret, credentialsKey } from '../src/lib/secret-box.js';
import { createAccountWithOwner } from '../src/lib/provision.js';
import { withDb } from './helpers/db.js';
import { testEnv } from './helpers/env.js';
let db: Awaited<ReturnType<typeof withDb>>;
let agentId: string;
let conversationId: string;
const env = { ...testEnv(), KASPI_POS_URL: 'http://kaspi.test' };
const fetcher = vi.fn();
beforeEach(async () => {
  db = await withDb();
  const { accountId } = await createAccountWithOwner(db, { company: 'Kaspi test', email: 'kaspi@example.com', name: 'Owner', initials: 'O', password: 'test-password-long' });
  const [agent] = await db.insert(agents).values({ accountId, name: 'Cashier', currency: 'KZT' }).returning();
  agentId = agent!.id;
  await db.insert(stages).values({ agentId, name: 'Paid', color: '#11aa66', kind: 'success', position: 1 });
  const [number] = await db.insert(whatsappNumbers).values({ agentId, phoneNumberId: 'kaspi', displayPhone: '+77011234567', wabaId: 'waba', accessToken: 'x' }).returning();
  const [contact] = await db.insert(contacts).values({ agentId, phone: '77011234567' }).returning();
  const [conversation] = await db.insert(conversations).values({ agentId, contactId: contact!.id, whatsappNumberId: number!.id }).returning();
  conversationId = conversation!.id;
  await db.insert(kaspiSessions).values({ agentId, credentials: encryptSecret(JSON.stringify({ tokenSN: 'cashier-token', vtokenSecret: 'private-secret' }), credentialsKey(env), sessionAad(agentId)) });
  fetcher.mockReset();
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => vi.unstubAllGlobals());
const input = () => ({ agentId, conversationId, amount: '1000', phone: '7011234567', requestKey: 'message-1' });
const reply = (Data: Record<string, unknown>) => new Response(JSON.stringify({ StatusCode: 0, Data }));
describe('durable Kaspi checkout', () => {
  it('deduplicates requests, stays pending until provider Processed and confirms once', async () => {
    fetcher.mockResolvedValueOnce(reply({ QrOperationId: 'operation-1' }));
    const created = await createKaspiCheckout(db, env, input());
    expect(created.method).toBe('invoice');
    expect(await hasConfirmedKaspiPayment(db, agentId, conversationId)).toBe(false);
    expect((await createKaspiCheckout(db, env, input())).id).toBe(created.id);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(createKaspiCheckout(db, env, { ...input(), requestKey: 'message-2' })).rejects.toThrow();
    fetcher.mockResolvedValueOnce(reply({ Id: 'operation-1', Status: 'RemotePaymentCreated' }));
    expect((await reconcileKaspiPayment(db, env, agentId, created.id)).status).toBe('pending');
    fetcher.mockResolvedValueOnce(reply({ Id: 'operation-1', Status: 'Processed', Amount: '1000.00' }));
    expect((await reconcileKaspiPayment(db, env, agentId, created.id)).status).toBe('paid');
    expect(await hasConfirmedKaspiPayment(db, agentId, conversationId)).toBe(true);
    const [order] = await db.select().from(orders).where(eq(orders.id, created.orderId));
    expect(order?.paidAt).toBeTruthy();
    expect((await db.select().from(stageTransitions))).toHaveLength(1);
    expect((await db.select().from(conversations))[0]?.stageSetBy).toBe('system');
    // The order is paid at the very moment the lead enters the sale stage: one sale episode.
    expect((await db.select().from(conversations))[0]?.stageSetAt?.getTime()).toBe(order!.paidAt!.getTime());
    await reconcileKaspiPayment(db, env, agentId, created.id);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('refuses a new invoice while the paid deal stands in the sale stage, and allows a repeat purchase once moved out', async () => {
    const [sale] = await db.select().from(stages).where(eq(stages.agentId, agentId));
    const [work] = await db.insert(stages).values({ agentId, name: 'Work', color: '#8a94a6', kind: 'active', position: 0 }).returning();
    await db.update(conversations).set({ stageId: sale!.id, stageSetAt: new Date() }).where(eq(conversations.id, conversationId));
    await db.insert(orders).values({ agentId, conversationId, amount: '6990', currency: 'KZT', status: 'paid', comment: 'Оплата по переписке', paidAt: new Date() });
    await expect(createKaspiCheckout(db, env, input())).rejects.toMatchObject({ statusCode: 409, message: 'У сделки уже есть оплаченный заказ' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await db.select().from(kaspiPayments)).toHaveLength(0);

    await db.update(conversations).set({ stageId: work!.id, stageSetAt: new Date() }).where(eq(conversations.id, conversationId));
    fetcher.mockResolvedValueOnce(reply({ QrOperationId: 'operation-repeat' }));
    expect((await createKaspiCheckout(db, env, input())).status).toBe('pending');
  });
  it('retains an unknown create and never sends a second invoice after a timeout', async () => {
    fetcher.mockRejectedValue(new Error('timeout'));
    const created = await createKaspiCheckout(db, env, input());
    expect(created.status).toBe('unknown');
    expect((await createKaspiCheckout(db, env, input())).status).toBe('unknown');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await hasConfirmedKaspiPayment(db, agentId, conversationId)).toBe(false);
  });
  it('rejects amount mismatches and another operation, without marking paid', async () => {
    fetcher.mockResolvedValueOnce(reply({ QrOperationId: 'operation-1' }));
    const created = await createKaspiCheckout(db, env, input());
    fetcher.mockResolvedValueOnce(reply({ Id: 'operation-1', Status: 'Processed', Amount: '1' }));
    await expect(reconcileKaspiPayment(db, env, agentId, created.id)).rejects.toThrow();
    fetcher.mockResolvedValueOnce(reply({ Id: 'other', Status: 'Processed', Amount: '1000' }));
    await expect(reconcileKaspiPayment(db, env, agentId, created.id)).rejects.toThrow();
    expect((await db.select().from(kaspiPayments))[0]?.status).toBe('pending');
  });
  it('cancels expired orders and allows a fresh explicit QR checkout', async () => {
    fetcher.mockResolvedValueOnce(reply({ QrOperationId: 'operation-1' }));
    const created = await createKaspiCheckout(db, env, input());
    fetcher.mockResolvedValueOnce(reply({ Id: 'operation-1', Status: 'Expired' }));
    expect((await reconcileKaspiPayment(db, env, agentId, created.id)).status).toBe('expired');
    expect((await db.select().from(orders))[0]?.status).toBe('cancelled');
    fetcher.mockResolvedValueOnce(reply({ QrOperationId: 'operation-2', QrToken: 'QR-CONTENT' }));
    const qr = await createKaspiCheckout(db, env, { ...input(), method: 'qr', requestKey: 'qr-request' });
    expect(qr.qrToken).toBe('QR-CONTENT');
    expect(fetcher.mock.calls[2]?.[0]).toBe('http://kaspi.test/api/qr/create');
  });
  it('does not reveal another agent payment', async () => {
    fetcher.mockResolvedValueOnce(reply({ QrOperationId: 'operation-1' }));
    const created = await createKaspiCheckout(db, env, input());
    await expect(reconcileKaspiPayment(db, env, '00000000-0000-4000-8000-000000000000', created.id)).rejects.toThrow('Счёт не найден');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent checkout keys and rejects non-KZT agents before provider calls', async () => {
    await db.update(agents).set({ currency: 'USD' }).where(eq(agents.id, agentId));
    await expect(createKaspiCheckout(db, env, input())).rejects.toThrow('тенге');
    expect(fetcher).not.toHaveBeenCalled();
    await db.update(agents).set({ currency: 'KZT' }).where(eq(agents.id, agentId));
    fetcher.mockImplementation(async () => reply({ QrOperationId: 'operation-1' }));
    const results = await Promise.all([createKaspiCheckout(db, env, input()), createKaspiCheckout(db, env, input())]);
    expect(results[0]?.id).toBe(results[1]?.id);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await db.select().from(orders)).toHaveLength(1);
  });
  it('creates QR only after provider confirms invoice cancellation', async () => {
    fetcher.mockResolvedValueOnce(reply({ QrOperationId: 'operation-1' }));
    await createKaspiCheckout(db, env, input());
    fetcher.mockResolvedValueOnce(reply({}));
    fetcher.mockResolvedValueOnce(reply({ Id: 'operation-1', Status: 'RemotePaymentCreated' }));
    await expect(createKaspiCheckout(db, env, { ...input(), method: 'qr', requestKey: 'qr-1' })).rejects.toThrow('QR не создан');
    expect(fetcher).toHaveBeenCalledTimes(3);
    fetcher.mockResolvedValueOnce(reply({}));
    fetcher.mockResolvedValueOnce(reply({ Id: 'operation-1', Status: 'RemotePaymentCanceled' }));
    fetcher.mockResolvedValueOnce(reply({ QrOperationId: 'qr-1', QrToken: 'token' }));
    const qr = await createKaspiCheckout(db, env, { ...input(), method: 'qr', requestKey: 'qr-1' });
    expect(qr.method).toBe('qr');
    expect((await db.select().from(orders)).filter((order) => order.status === 'cancelled')).toHaveLength(1);
  });
  it('keeps a paid invoice when cancellation races with payment', async () => {
    fetcher.mockResolvedValueOnce(reply({ QrOperationId: 'operation-1' }));
    await createKaspiCheckout(db, env, input());
    fetcher.mockResolvedValueOnce(reply({}));
    fetcher.mockResolvedValueOnce(reply({ Id: 'operation-1', Status: 'Processed', Amount: 1000 }));
    await expect(createKaspiCheckout(db, env, { ...input(), method: 'qr', requestKey: 'qr-1' })).rejects.toThrow();
    expect(await hasConfirmedKaspiPayment(db, agentId, conversationId)).toBe(true);
    expect(await db.select().from(orders)).toHaveLength(1);
  });
  it('disconnects an explicitly rejected session while preserving unknown payment intent', async () => {
    fetcher.mockResolvedValueOnce(new Response('{}', { status: 401 }));
    expect((await createKaspiCheckout(db, env, input())).status).toBe('unknown');
    expect((await db.select().from(kaspiSessions))[0]?.credentials).toBeNull();
  });

  it('polls an unchecked invoice ahead of fifty previously checked pending invoices', async () => {
    const [source] = await db.select().from(conversations).where(eq(conversations.id, conversationId));
    for (let index = 0; index < 50; index++) {
      const [contact] = await db.insert(contacts).values({ agentId, phone: `7701000${String(index).padStart(4, '0')}` }).returning();
      const [conversation] = await db.insert(conversations).values({
        agentId, contactId: contact!.id, whatsappNumberId: source!.whatsappNumberId,
      }).returning();
      const [order] = await db.insert(orders).values({ agentId, conversationId: conversation!.id, amount: '1000', currency: 'KZT' }).returning();
      await db.insert(kaspiPayments).values({
        agentId, conversationId: conversation!.id, orderId: order!.id,
        requestKey: `old-${index}`, operationId: `old-${index}`, method: 'invoice',
        phone: '77011234567', amount: '1000', status: 'pending', checkedAt: new Date(Date.now() - 60_000),
      });
    }
    fetcher.mockResolvedValueOnce(reply({ QrOperationId: 'unchecked' }));
    const created = await createKaspiCheckout(db, env, input());
    fetcher.mockReset();
    fetcher.mockImplementation(async (url: string) => {
      const id = new URL(url).searchParams.get('operationId');
      return reply({ Id: id, Status: id === 'unchecked' ? 'Processed' : 'RemotePaymentCreated', Amount: 1000 });
    });
    await reconcileKaspiPayments(db, env);
    expect(fetcher).toHaveBeenCalledTimes(50);
    expect(fetcher.mock.calls[0]?.[0]).toContain('operationId=unchecked');
    const [payment] = await db.select().from(kaspiPayments).where(eq(kaspiPayments.id, created.id));
    expect(payment?.status).toBe('paid');
    expect(await hasConfirmedKaspiPayment(db, agentId, conversationId)).toBe(true);
  });

});
