import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { agents } from '../src/db/schema.js';
import { addMember, createAccountWithOwner } from '../src/lib/provision.js';
import { withDb } from './helpers/db.js';
import { testEnv } from './helpers/env.js';
import { fakeGraph } from './helpers/fake-graph.js';

const PASSWORD = 'correct-horse-battery';
let db: Awaited<ReturnType<typeof withDb>>;
let app: FastifyInstance;
let agentId: string;
let ownerJar: Record<string, string>;
let memberJar: Record<string, string>;

async function login(email: string): Promise<Record<string, string>> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: PASSWORD },
  });
  const cookie = response.cookies[0]!;
  return { [cookie.name]: cookie.value };
}

beforeEach(async () => {
  db = await withDb();
  const seeded = await createAccountWithOwner(db, {
    company: 'Style',
    email: 'style-owner@example.test',
    name: 'Owner',
    initials: 'OW',
    password: PASSWORD,
  });
  await addMember(db, {
    company: 'Style',
    email: 'style-member@example.test',
    name: 'Member',
    initials: 'MB',
    password: PASSWORD,
    role: 'member',
  });
  const [agent] = await db.insert(agents).values({ accountId: seeded.accountId, name: 'Agent' }).returning();
  agentId = agent!.id;
  app = buildServer(testEnv(), db, { graph: fakeGraph() });
  await app.ready();
  ownerJar = await login('style-owner@example.test');
  memberJar = await login('style-member@example.test');
});

afterEach(async () => app.close());

describe('agent communication style API', () => {
  it('lets account members read the saved preset and deterministic Russian preview', async () => {
    const url = `/api/agents/${agentId}/communication-style`;
    const first = await app.inject({ method: 'GET', url, cookies: memberJar });
    const second = await app.inject({ method: 'GET', url, cookies: memberJar });

    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({
      preset: 'warm',
      preview: 'Здравствуйте! С радостью помогу 😊 Подскажите, что вас интересует?',
    });
    expect(second.json()).toEqual(first.json());
  });

  it('lets only the owner change a valid preset and bumps configVersion only when it changes', async () => {
    const url = `/api/agents/${agentId}/communication-style`;
    const before = (await db.select({ value: agents.configVersion }).from(agents).where(eq(agents.id, agentId)))[0]!.value;

    const forbidden = await app.inject({ method: 'PATCH', url, cookies: memberJar, payload: { preset: 'friendly' } });
    expect(forbidden.statusCode).toBe(403);
    const changed = await app.inject({ method: 'PATCH', url, cookies: ownerJar, payload: { preset: 'friendly' } });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toEqual({
      preset: 'friendly',
      preview: 'Привет! Давайте разберёмся 🙂 Что именно вы ищете?',
    });
    const afterChange = (await db.select({ value: agents.configVersion }).from(agents).where(eq(agents.id, agentId)))[0]!.value;
    expect(afterChange).toBe(before + 1);

    expect((await app.inject({ method: 'PATCH', url, cookies: ownerJar, payload: { preset: 'friendly' } })).statusCode).toBe(200);
    expect((await db.select({ value: agents.configVersion }).from(agents).where(eq(agents.id, agentId)))[0]!.value).toBe(afterChange);
    expect((await app.inject({ method: 'PATCH', url, cookies: ownerJar, payload: { preset: 'formal' } })).statusCode).toBe(400);
  });
});
