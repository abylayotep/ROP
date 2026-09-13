import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { accountMembers, agentRules } from '../src/db/schema.js';
import { SEALHOUSE_PAYMENT_RULE, ensureSealhousePaymentPolicy } from '../src/lib/payment-policy.js';
import { createAccountWithOwner } from '../src/lib/provision.js';
import { withDb } from './helpers/db.js';
import { testEnv } from './helpers/env.js';

const env = testEnv();

const PASSWORD = 'correct-horse-battery';

let app: FastifyInstance;
let db: Awaited<ReturnType<typeof withDb>>;
let accountId: string;
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

beforeEach(async () => {
  db = await withDb();
  app = buildServer(env, db);
  await app.ready();

  const created = await createAccountWithOwner(db, {
    company: 'Сафина',
    email: 'owner@example.com',
    name: 'Владелец',
    initials: 'ВЛ',
    password: PASSWORD,
  });
  accountId = created.accountId;
  jar = await login('owner@example.com');
});

const createAgent = (payload: Record<string, unknown>, cookies = jar) =>
  app.inject({ method: 'POST', url: `/api/accounts/${accountId}/agents`, cookies, payload });

describe('agent routes', () => {
  it('answers /auth/me with the accounts the person belongs to', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/me', cookies: jar });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      name: 'Владелец',
      initials: 'ВЛ',
      email: 'owner@example.com',
      accounts: [{ id: accountId, name: 'Сафина', role: 'owner' }],
    });
  });

  it('returns the same payload from login', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'owner@example.com', password: PASSWORD },
    });

    expect(res.json().accounts).toEqual([{ id: accountId, name: 'Сафина', role: 'owner' }]);
  });

  it('creates an agent and lists it', async () => {
    const created = await createAgent({ name: 'Сафина', description: 'Светильники' });

    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({
      accountId,
      name: 'Сафина',
      description: 'Светильники',
      timezone: 'Asia/Almaty',
    });

    const list = await app.inject({
      method: 'GET',
      url: `/api/accounts/${accountId}/agents`,
      cookies: jar,
    });
    expect(list.json()).toHaveLength(1);
  });

  it('adds the exact payment policy only to Sealhouse and remains idempotent', async () => {
    const ordinary = await createAgent({ name: 'Другой магазин' });
    const sealhouse = await createAgent({ name: ' SealHouse ' });
    await ensureSealhousePaymentPolicy(db);
    const rules = await db.select().from(agentRules);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ agentId: sealhouse.json().id, text: SEALHOUSE_PAYMENT_RULE });
    expect(rules[0]?.agentId).not.toBe(ordinary.json().id);
  });

  it('rejects an agent without a name', async () => {
    const res = await createAgent({ description: 'Без имени' });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('Укажите название агента');
  });

  it('hides another account behind a 404', async () => {
    const stranger = await createAccountWithOwner(db, {
      company: 'Чужая',
      email: 'stranger@example.com',
      name: 'Чужой',
      initials: 'ЧУ',
      password: PASSWORD,
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/accounts/${stranger.accountId}/agents`,
      cookies: jar,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().message).toBe('Компания не найдена');
  });

  it('answers 404 for a malformed account id instead of raising', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/accounts/not-a-uuid/agents',
      cookies: jar,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().message).toBe('Компания не найдена');
  });

  it('answers 404, not 403, when a stranger tries to create an agent', async () => {
    const stranger = await createAccountWithOwner(db, {
      company: 'Чужая',
      email: 'stranger@example.com',
      name: 'Чужой',
      initials: 'ЧУ',
      password: PASSWORD,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/accounts/${stranger.accountId}/agents`,
      cookies: jar,
      payload: { name: 'Подсадной' },
    });

    // 403 would confirm the company exists to someone who has no business knowing it.
    expect(res.statusCode).toBe(404);
    expect(res.json().message).toBe('Компания не найдена');
  });

  it('refuses to let a member create an agent', async () => {
    await db
      .update(accountMembers)
      .set({ role: 'member' })
      .where(eq(accountMembers.accountId, accountId));

    const res = await createAgent({ name: 'Второй' });

    expect(res.statusCode).toBe(403);
    expect(res.json().message).toBe('Недостаточно прав');
  });

  it('answers an empty patch with the agent unchanged', async () => {
    const { id } = (await createAgent({ name: 'Сафина' })).json();

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/agents/${id}`,
      cookies: jar,
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('Сафина');
  });

  it('reads and renames one agent', async () => {
    const { id } = (await createAgent({ name: 'Сафина' })).json();

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/agents/${id}`,
      cookies: jar,
      payload: { name: 'Сафина 2.0', timezone: 'Europe/Moscow' },
    });
    expect(patched.json()).toMatchObject({ name: 'Сафина 2.0', timezone: 'Europe/Moscow' });

    const read = await app.inject({ method: 'GET', url: `/api/agents/${id}`, cookies: jar });
    expect(read.json().name).toBe('Сафина 2.0');
  });
});
