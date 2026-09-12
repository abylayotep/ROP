import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { agents, contacts, conversations, orders, whatsappNumbers } from '../src/db/schema.js';
import { addMember, createAccountWithOwner } from '../src/lib/provision.js';
import { withDb } from './helpers/db.js';
import { testEnv } from './helpers/env.js';
import { fakeGraph } from './helpers/fake-graph.js';

const env = testEnv();
const PASSWORD = 'correct-horse-battery';

let app: FastifyInstance;
let db: Awaited<ReturnType<typeof withDb>>;
let accountId: string;
let agentId: string;
let conversationId: string;
let jar: Record<string, string>;

async function login(email: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: PASSWORD },
  });
  const cookie = res.cookies[0]!;
  return { [cookie.name]: cookie.value };
}

const ordersUrl = () => `/api/agents/${agentId}/conversations/${conversationId}/orders`;

/** Records an order and returns its id. */
async function record(payload: Record<string, unknown>) {
  const res = await app.inject({ method: 'POST', url: ordersUrl(), cookies: jar, payload });
  return { res, id: res.json().orders?.at(-1)?.id as string };
}

beforeEach(async () => {
  db = await withDb();
  ({ accountId } = await createAccountWithOwner(db, {
    company: 'Сафина',
    email: 'owner@example.com',
    name: 'Владелец',
    initials: 'ВЛ',
    password: PASSWORD,
  }));
  await addMember(db, {
    company: 'Сафина',
    email: 'member@example.com',
    name: 'Оператор',
    initials: 'ОП',
    password: PASSWORD,
    role: 'member',
  });

  app = buildServer(env, db, { graph: fakeGraph() });
  await app.ready();
  jar = await login('owner@example.com');

  const created = await app.inject({
    method: 'POST',
    url: `/api/accounts/${accountId}/agents`,
    cookies: jar,
    payload: { name: 'Сафина' },
  });
  agentId = created.json().id;

  const [number] = await db
    .insert(whatsappNumbers)
    .values({
      agentId,
      phoneNumberId: '136',
      wabaId: 'waba',
      displayPhone: '+7 708 580 79 32',
      accessToken: 'x',
    })
    .returning();
  const [contact] = await db
    .insert(contacts)
    .values({ agentId, phone: '77085807932', name: 'Айгуль' })
    .returning();
  const [conversation] = await db
    .insert(conversations)
    .values({ agentId, contactId: contact!.id, whatsappNumberId: number!.id })
    .returning();
  conversationId = conversation!.id;
});

afterEach(async () => {
  await app.close();
});

describe('recording an order', () => {
  it('starts pending, in the currency of its agent, and counts nothing yet', async () => {
    const { res } = await record({ amount: '450000' });

    expect(res.statusCode).toBe(200);
    const order = res.json().orders[0];
    expect(order.amount).toBe('450000.00');
    expect(order.currency).toBe('KZT');
    expect(order.status).toBe('pending');
    expect(order.paidAt).toBeNull();
    expect(res.json().paidTotal).toBe('0.00');
  });

  it('records a comment', async () => {
    const { res } = await record({ amount: '1000', comment: 'Две двери, монтаж в среду' });

    expect(res.json().orders[0].comment).toBe('Две двери, монтаж в среду');
  });

  it('rejects a manually paid order', async () => {
    const { res } = await record({ amount: '450000.50', status: 'paid' });

    expect(res.statusCode).toBe(409);
    expect(await db.select().from(orders)).toHaveLength(0);
  });

  it('keeps a second purchase as a second order', async () => {
    await record({ amount: '100000' });
    const { res } = await record({ amount: '50000' });

    expect(res.json().orders).toHaveLength(2);
    expect(res.json().paidTotal).toBe('0.00');
  });

  it('refuses an amount that is not a plain number', async () => {
    for (const amount of ['1e5', 'Infinity', '0x10', '-100', '1.234', '', 'сто тысяч']) {
      const res = await app.inject({
        method: 'POST',
        url: ordersUrl(),
        cookies: jar,
        payload: { amount },
      });
      expect(res.statusCode, amount).toBe(400);
    }
  });

  it('refuses an amount too large for the column', async () => {
    const res = await app.inject({
      method: 'POST',
      url: ordersUrl(),
      cookies: jar,
      payload: { amount: '1234567890123' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('refuses a comment longer than the cap', async () => {
    const res = await app.inject({
      method: 'POST',
      url: ordersUrl(),
      cookies: jar,
      payload: { amount: '1000', comment: 'а'.repeat(501) },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('Комментарий');
  });

  it('takes the currency from the agent even when the client names one', async () => {
    const { res } = await record({ amount: '1000', currency: 'USD' });

    expect(res.json().orders[0].currency).toBe('KZT');
    const [stored] = await db.select().from(orders);
    expect(stored!.currency).toBe('KZT');
  });

  it('accepts zero, which is how a gift is recorded', async () => {
    const { res } = await record({ amount: '0' });

    expect(res.json().orders[0].amount).toBe('0.00');
  });
});

describe('changing an order', () => {
  it('rejects a manual paid status', async () => {
    const { id } = await record({ amount: '450000' });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/agents/${agentId}/orders/${id}`,
      cookies: jar,
      payload: { status: 'paid' },
    });

    expect(res.statusCode).toBe(409);
    expect((await db.select().from(orders))[0]?.paidAt).toBeNull();
  });

  it('keeps the original payment time when something else changes', async () => {
    const { id } = await record({ amount: '450000' });
    await db.update(orders).set({ status: 'paid', paidAt: new Date() }).where(eq(orders.id, id));
    const first = (
      await app.inject({
        url: `/api/agents/${agentId}/conversations/${conversationId}/lead`,
        cookies: jar,
      })
    ).json().orders[0].paidAt;

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/agents/${agentId}/orders/${id}`,
      cookies: jar,
      payload: { comment: 'Оплата картой' },
    });

    expect(res.json().orders[0].paidAt).toBe(first);
  });

  it('preserves a paid order when cancellation is attempted', async () => {
    const { id } = await record({ amount: '450000' });
    await db.update(orders).set({ status: 'paid', paidAt: new Date() }).where(eq(orders.id, id));

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/agents/${agentId}/orders/${id}`,
      cookies: jar,
      payload: { status: 'cancelled' },
    });

    expect(res.statusCode).toBe(409);
    expect((await db.select().from(orders))[0]?.paidAt).not.toBeNull();
  });

  it('preserves a paid order when reverting to pending is attempted', async () => {
    const { id } = await record({ amount: '450000' });
    await db.update(orders).set({ status: 'paid', paidAt: new Date() }).where(eq(orders.id, id));

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/agents/${agentId}/orders/${id}`,
      cookies: jar,
      payload: { status: 'pending' },
    });

    expect(res.statusCode).toBe(409);
    expect((await db.select().from(orders))[0]?.paidAt).not.toBeNull();
  });

  it('refuses a status nobody defined', async () => {
    const { id } = await record({ amount: '450000' });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/agents/${agentId}/orders/${id}`,
      cookies: jar,
      payload: { status: 'refunded' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('does not delete a paid order', async () => {
    const { id } = await record({ amount: '450000' });
    await db.update(orders).set({ status: 'paid', paidAt: new Date() }).where(eq(orders.id, id));

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/agents/${agentId}/orders/${id}`,
      cookies: jar,
    });

    expect(res.statusCode).toBe(409);
    expect(await db.select().from(orders)).toHaveLength(1);
  });
});

describe('access', () => {
  it('lets a member record an order', async () => {
    const memberJar = await login('member@example.com');

    const res = await app.inject({
      method: 'POST',
      url: ordersUrl(),
      cookies: memberJar,
      payload: { amount: '1000' },
    });

    expect(res.statusCode).toBe(200);
  });

  it("answers 404 for another agent's order", async () => {
    const { id } = await record({ amount: '450000' });
    const [other] = await db.insert(agents).values({ accountId, name: 'Другая' }).returning();

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/agents/${other!.id}/orders/${id}`,
      cookies: jar,
      payload: { status: 'paid' },
    });

    expect(res.statusCode).toBe(404);
  });

  it('answers 404 for an order id that is not a uuid', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/agents/${agentId}/orders/не-uuid`,
      cookies: jar,
    });

    expect(res.statusCode).toBe(404);
  });
});
