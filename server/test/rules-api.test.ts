import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
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
let jar: Record<string, string>;
let memberJar: Record<string, string>;

async function login(email = 'owner@example.com') {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: PASSWORD },
  });
  const cookie = res.cookies[0]!;
  return { [cookie.name]: cookie.value };
}

const rules = () => `/api/agents/${agentId}/rules`;

async function post(payload: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: rules(), cookies: jar, payload });
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
  jar = await login();
  memberJar = await login('member@example.com');

  const created = await app.inject({
    method: 'POST',
    url: `/api/accounts/${accountId}/agents`,
    cookies: jar,
    payload: { name: 'Сафина' },
  });
  agentId = created.json().id;
});

afterEach(async () => {
  await app.close();
});

describe('rules', () => {
  it('creates a rule at the end of its category', async () => {
    await post({ category: 'tone', text: 'На «вы».' });
    const second = await post({ category: 'tone', text: 'Без смайликов.' });
    expect(second.json().position).toBe(1);
  });

  it('refuses an unknown category and text over the limit', async () => {
    expect((await post({ category: 'банан', text: 'Раз.' })).statusCode).toBe(400);
    expect((await post({ category: 'tone', text: 'а'.repeat(501) })).statusCode).toBe(400);
  });

  it('switches a rule off without deleting it', async () => {
    const rule = (await post({ category: 'forbid', text: 'Не обещай скидку.' })).json();
    const res = await app.inject({
      method: 'PATCH',
      url: `${rules()}/${rule.id}`,
      cookies: jar,
      payload: { enabled: false },
    });
    expect(res.json().enabled).toBe(false);
  });

  it('reorders inside a category', async () => {
    const a = (await post({ category: 'order', text: 'Сначала район.' })).json();
    const b = (await post({ category: 'order', text: 'Потом сроки.' })).json();
    await app.inject({
      method: 'PATCH',
      url: `${rules()}/${b.id}`,
      cookies: jar,
      payload: { position: 0 },
    });
    const list = (await app.inject({ method: 'GET', url: rules(), cookies: jar })).json();
    expect(list.map((r: { id: string }) => r.id)).toEqual([b.id, a.id]);
  });

  // A reordering bug that merely swaps the moved row's own position (instead of closing the
  // gap it left and opening the one it took) is invisible to a two-rule test: with only two
  // rules there is no third row whose position could silently collide with the moved one.
  // Three rules, moved from last to first, forces every row in between to shift — the failure
  // this guards against is two rules ending up sharing a position, which sorts however
  // Postgres feels like rather than however the owner arranged them.
  it('moves the last rule of three to the front and shifts the rest down', async () => {
    const a = (await post({ category: 'order', text: 'Первое.' })).json();
    const b = (await post({ category: 'order', text: 'Второе.' })).json();
    const c = (await post({ category: 'order', text: 'Третье.' })).json();

    const res = await app.inject({
      method: 'PATCH',
      url: `${rules()}/${c.id}`,
      cookies: jar,
      payload: { position: 0 },
    });
    expect(res.json().position).toBe(0);

    const list = (await app.inject({ method: 'GET', url: rules(), cookies: jar })).json();
    expect(list.map((r: { id: string }) => r.id)).toEqual([c.id, a.id, b.id]);
    expect(list.map((r: { position: number }) => r.position)).toEqual([0, 1, 2]);
  });

  it('refuses a member every rules route', async () => {
    for (const call of [
      { method: 'GET' as const, url: rules() },
      { method: 'POST' as const, url: rules(), payload: { category: 'tone', text: 'На «вы».' } },
    ]) {
      expect((await app.inject({ ...call, cookies: memberJar })).statusCode).toBe(403);
    }
  });

  it('refuses a rule of another agent with 404', async () => {
    const rule = (await post({ category: 'tone', text: 'На «вы».' })).json();
    const { accountId: otherAccountId } = await createAccountWithOwner(db, {
      company: 'Другая',
      email: 'other@example.com',
      name: 'Другой',
      initials: 'ДР',
      password: PASSWORD,
    });
    const otherJar = await login('other@example.com');
    const otherAgent = await app.inject({
      method: 'POST',
      url: `/api/accounts/${otherAccountId}/agents`,
      cookies: otherJar,
      payload: { name: 'Другая' },
    });
    const otherAgentId = otherAgent.json().id;

    const res = await app.inject({
      method: 'PATCH',
      cookies: otherJar,
      url: `/api/agents/${otherAgentId}/rules/${rule.id}`,
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().message).toBe('Правило не найдено');
  });

  it('deletes a rule', async () => {
    const rule = (await post({ category: 'business', text: 'Мы продаём двери.' })).json();
    const res = await app.inject({ method: 'DELETE', url: `${rules()}/${rule.id}`, cookies: jar });
    expect(res.statusCode).toBe(200);

    const list = (await app.inject({ method: 'GET', url: rules(), cookies: jar })).json();
    expect(list).toEqual([]);
  });
});
