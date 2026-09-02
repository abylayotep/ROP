import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { requireAgent } from '../src/api/require-agent.js';
import { requireSession } from '../src/api/require-session.js';
import { buildServer } from '../src/api/server.js';
import { accountMembers, accounts, agents } from '../src/db/schema.js';
import { loadEnv } from '../src/env.js';
import { createAccountWithOwner } from '../src/lib/provision.js';
import { withDb } from './helpers/db.js';

const env = loadEnv({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://x',
  SESSION_SECRET: 'x'.repeat(32),
} as NodeJS.ProcessEnv);

let app: FastifyInstance;
let db: Awaited<ReturnType<typeof withDb>>;
let ownAgentId: string;
let otherAgentId: string;

/** Logs in and returns a cookie jar for app.inject(). */
async function login(email: string, password = 'correct-horse-battery') {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password },
  });
  const cookie = res.cookies[0]!;
  return { [cookie.name]: cookie.value };
}

beforeEach(async () => {
  db = await withDb();
  app = buildServer(env, db);

  // Two routes that exist only for this test: they prove the guard's decision without
  // depending on any real endpoint's behaviour.
  const guard = requireSession(db);
  app.get(
    '/api/agents/:agentId/probe',
    { preHandler: [guard, requireAgent(db)] },
    async (req) => ({ name: req.agent!.name, role: req.role }),
  );
  app.get(
    '/api/agents/:agentId/owner-probe',
    { preHandler: [guard, requireAgent(db, { role: 'owner' })] },
    async () => ({ ok: true }),
  );
  await app.ready();

  const own = await createAccountWithOwner(db, {
    company: 'Сафина',
    email: 'owner@example.com',
    name: 'Владелец',
    initials: 'ВЛ',
    password: 'correct-horse-battery',
  });
  const [ownAgent] = await db
    .insert(agents)
    .values({ accountId: own.accountId, name: 'Сафина' })
    .returning();
  ownAgentId = ownAgent!.id;

  const stranger = await createAccountWithOwner(db, {
    company: 'Чужая',
    email: 'stranger@example.com',
    name: 'Чужой',
    initials: 'ЧУ',
    password: 'correct-horse-battery',
  });
  const [otherAgent] = await db
    .insert(agents)
    .values({ accountId: stranger.accountId, name: 'Чужой агент' })
    .returning();
  otherAgentId = otherAgent!.id;
});

describe('requireAgent', () => {
  it('lets a member of the account through', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/agents/${ownAgentId}/probe`,
      cookies: await login('owner@example.com'),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ name: 'Сафина', role: 'owner' });
  });

  it('hides another account agent behind a 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/agents/${otherAgentId}/probe`,
      cookies: await login('owner@example.com'),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().message).toBe('Агент не найден');
  });

  it('answers 404 for a malformed id instead of raising', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/agents/not-a-uuid/probe',
      cookies: await login('owner@example.com'),
    });

    expect(res.statusCode).toBe(404);
  });

  it('refuses a member on an owner-only route', async () => {
    const [account] = await db.select().from(accounts).where(eq(accounts.name, 'Сафина'));
    await db
      .update(accountMembers)
      .set({ role: 'member' })
      .where(eq(accountMembers.accountId, account!.id));

    const res = await app.inject({
      method: 'GET',
      url: `/api/agents/${ownAgentId}/owner-probe`,
      cookies: await login('owner@example.com'),
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().message).toBe('Недостаточно прав');
  });

  it('still requires a session', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/agents/${ownAgentId}/probe` });

    expect(res.statusCode).toBe(401);
  });
});
