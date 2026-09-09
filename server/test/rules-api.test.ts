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

  // `assembleRules` (lib/ai/rules.ts) renders business, then tone, then order, then forbid —
  // the order the model actually reads. SQL `asc(category)` gives business, forbid, order,
  // tone (alphabetical) instead: harmless today only because `assembleRules` re-groups from
  // scratch, but a screen rendering the wire order would show the owner a sequence the agent
  // never uses.
  it('returns categories in the order the prompt reads them, not alphabetically', async () => {
    await post({ category: 'forbid', text: 'Не давай скидку.' });
    await post({ category: 'business', text: 'Мы продаём двери.' });
    await post({ category: 'tone', text: 'На «вы».' });
    await post({ category: 'order', text: 'Сначала район.' });

    const list = (await app.inject({ method: 'GET', url: rules(), cookies: jar })).json();
    expect(list.map((r: { category: string }) => r.category)).toEqual(['business', 'tone', 'order', 'forbid']);
  });

  // The reviewer's repro: two concurrent PATCHes, each moving a *different* rule of the same
  // category to the same target position. Under READ COMMITTED, both requests can read
  // `categorySize`/`current.position` from a snapshot taken before either wrote anything,
  // compute the same target, and then write their own row by primary key — writes that never
  // block each other because they touch different rows. Both commit, and the category ends
  // with a duplicated position and a gap where one used to be.
  //
  // Inherently probabilistic — whether the two `app.inject` calls actually overlap inside
  // Postgres depends on scheduling — so this runs 20 trials, each against a fresh trio of
  // rules, and asserts the *whole* category is left dense and unique (no duplicate position,
  // no gap) after every single one. The reviewer's own repro against these same routes hit
  // the duplicate in 3 of 20 trials before the fix below; running fewer trials risked a clean
  // pass by luck rather than by correctness.
  it('keeps positions dense and unique under two concurrent moves in one category', async () => {
    const TRIALS = 20;
    for (let trial = 0; trial < TRIALS; trial++) {
      const a = (await post({ category: 'business', text: `A${trial}` })).json();
      const b = (await post({ category: 'business', text: `B${trial}` })).json();
      const c = (await post({ category: 'business', text: `C${trial}` })).json();
      const mid = b.position; // the middle slot of this trial's fresh trio

      const [resA, resC] = await Promise.all([
        app.inject({
          method: 'PATCH',
          url: `${rules()}/${a.id}`,
          cookies: jar,
          payload: { position: mid },
        }),
        app.inject({
          method: 'PATCH',
          url: `${rules()}/${c.id}`,
          cookies: jar,
          payload: { position: mid },
        }),
      ]);
      expect(resA.statusCode).toBe(200);
      expect(resC.statusCode).toBe(200);

      const list = (await app.inject({ method: 'GET', url: rules(), cookies: jar })).json();
      const positions = list
        .filter((r: { category: string }) => r.category === 'business')
        .map((r: { position: number }) => r.position)
        .sort((x: number, y: number) => x - y);
      expect(positions).toEqual(Array.from({ length: positions.length }, (_, i) => i));
    }
  });

  // A PATCH that changes `category` locks both the rule's old and new category. Two such
  // moves running in opposite directions at once — one from `business` to `tone`, the other
  // from `tone` to `business` — are exactly the shape an AB-BA deadlock needs if each move
  // locked its own "old, then new" without agreeing on an order. `lockCategories` sorts the
  // two names before locking, so both requests always ask for `business` before `tone`
  // regardless of which way they're moving.
  //
  // 10 trials, each against a fresh pair of rules: neither request should ever time out or
  // 500 with a Postgres deadlock error, and both categories should stay dense and unique
  // afterward.
  it('moves rules between two categories in opposite directions without deadlocking', async () => {
    const TRIALS = 10;
    for (let trial = 0; trial < TRIALS; trial++) {
      const x = (await post({ category: 'business', text: `X${trial}` })).json();
      const y = (await post({ category: 'tone', text: `Y${trial}` })).json();

      const [resX, resY] = await Promise.all([
        app.inject({
          method: 'PATCH',
          url: `${rules()}/${x.id}`,
          cookies: jar,
          payload: { category: 'tone' },
        }),
        app.inject({
          method: 'PATCH',
          url: `${rules()}/${y.id}`,
          cookies: jar,
          payload: { category: 'business' },
        }),
      ]);
      expect(resX.statusCode).toBe(200);
      expect(resY.statusCode).toBe(200);

      const list = (await app.inject({ method: 'GET', url: rules(), cookies: jar })).json();
      for (const category of ['business', 'tone']) {
        const positions = list
          .filter((r: { category: string }) => r.category === category)
          .map((r: { position: number }) => r.position)
          .sort((a: number, b: number) => a - b);
        expect(positions).toEqual(Array.from({ length: positions.length }, (_, i) => i));
      }
    }
  });

  // The hole `FOR UPDATE` can't close: it locks *existing* rows, and a category that has
  // never held a rule for this agent has no row to lock. Two concurrent first-ever `POST`s
  // into such a category both count zero (nothing to block on) and both insert at position 0.
  //
  // Every category of every agent is in this state until its first rule lands, so this isn't
  // an exotic corner — it's the first two rules an owner ever types. A fresh agent per trial
  // guarantees the category is genuinely empty (never touched by this agent before), which a
  // shared agent across trials could not: 20 trials, each asserting the pair of rules lands
  // at exactly positions 0 and 1 with no duplicate.
  it('keeps positions dense and unique for two concurrent first-ever creates in an empty category', async () => {
    const TRIALS = 20;
    for (let trial = 0; trial < TRIALS; trial++) {
      const created = await app.inject({
        method: 'POST',
        url: `/api/accounts/${accountId}/agents`,
        cookies: jar,
        payload: { name: `Trial ${trial}` },
      });
      const freshAgentId = created.json().id;
      const freshRules = `/api/agents/${freshAgentId}/rules`;

      const [resA, resB] = await Promise.all([
        app.inject({
          method: 'POST',
          url: freshRules,
          cookies: jar,
          payload: { category: 'business', text: `A${trial}` },
        }),
        app.inject({
          method: 'POST',
          url: freshRules,
          cookies: jar,
          payload: { category: 'business', text: `B${trial}` },
        }),
      ]);
      expect(resA.statusCode).toBe(200);
      expect(resB.statusCode).toBe(200);

      const positions = [resA.json().position, resB.json().position].sort((a: number, b: number) => a - b);
      expect(positions).toEqual([0, 1]);
    }
  });
});
