import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { agents, stages } from '../src/db/schema.js';
import { createAccountWithOwner } from '../src/lib/provision.js';
import { DEFAULT_STAGES } from '../src/lib/funnel.js';
import { withDb } from './helpers/db.js';
import { testEnv } from './helpers/env.js';
import { fakeGraph } from './helpers/fake-graph.js';

const env = testEnv();
const PASSWORD = 'correct-horse-battery';

let app: FastifyInstance;
let db: Awaited<ReturnType<typeof withDb>>;
let accountId: string;
let jar: Record<string, string>;

beforeEach(async () => {
  db = await withDb();
  ({ accountId } = await createAccountWithOwner(db, {
    company: 'Сафина',
    email: 'owner@example.com',
    name: 'Владелец',
    initials: 'ВЛ',
    password: PASSWORD,
  }));

  app = buildServer(env, db, { graph: fakeGraph() });
  await app.ready();

  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'owner@example.com', password: PASSWORD },
  });
  const cookie = res.cookies[0]!;
  jar = { [cookie.name]: cookie.value };
});

afterEach(async () => {
  await app.close();
});

describe('the default funnel', () => {
  it('has exactly one sale stage', () => {
    expect(DEFAULT_STAGES.filter((stage) => stage.kind === 'success')).toHaveLength(1);
  });

  it('arrives with a new agent, in order', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/accounts/${accountId}/agents`,
      cookies: jar,
      payload: { name: 'Сафина' },
    });
    expect(res.statusCode).toBe(200);
    const agentId = res.json().id as string;

    const rows = await db
      .select()
      .from(stages)
      .where(eq(stages.agentId, agentId))
      .orderBy(asc(stages.position));

    expect(rows.map((row) => row.name)).toEqual([
      'Новый лид',
      'В диалоге',
      'Интерес проявлен',
      'Квалифицирован',
      'Предложение отправлено',
      'Готов к покупке',
      'Оплачено',
      'Отказ',
    ]);
    expect(rows.map((row) => row.position)).toEqual(DEFAULT_STAGES.map((_, i) => i));
    // The funnel arrives with its sales script: what each stage means and what the agent does on it.
    expect(rows.map((row) => row.description)).toEqual(DEFAULT_STAGES.map((stage) => stage.description));
    expect(rows.map((row) => row.agentGoal)).toEqual(DEFAULT_STAGES.map((stage) => stage.agentGoal));
    expect(rows.every((row) => row.agentGoal !== '')).toBe(true);
    expect(rows.every((row) => row.autoMessage === null)).toBe(true);
  });

  it('reports the currency of the agent it created', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/accounts/${accountId}/agents`,
      cookies: jar,
      payload: { name: 'Вторая' },
    });

    expect(res.json().currency).toBe('KZT');
  });

  it('gives each agent its own funnel', async () => {
    const before = await db.select().from(agents);
    const first = await app.inject({
      method: 'POST',
      url: `/api/accounts/${accountId}/agents`,
      cookies: jar,
      payload: { name: 'Третья' },
    });
    const second = await app.inject({
      method: 'POST',
      url: `/api/accounts/${accountId}/agents`,
      cookies: jar,
      payload: { name: 'Четвёртая' },
    });

    const one = await db.select().from(stages).where(eq(stages.agentId, first.json().id));
    const two = await db.select().from(stages).where(eq(stages.agentId, second.json().id));

    expect(one).toHaveLength(DEFAULT_STAGES.length);
    expect(two).toHaveLength(DEFAULT_STAGES.length);
    expect(await db.select().from(agents)).toHaveLength(before.length + 2);
  });
});
