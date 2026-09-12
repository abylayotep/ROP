import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import type { Db } from '../src/db/client.js';
import { agents, contacts } from '../src/db/schema.js';
import { addMember, createAccountWithOwner } from '../src/lib/provision.js';
import { withDb } from './helpers/db.js';
import { testEnv } from './helpers/env.js';
import { fakeGraph } from './helpers/fake-graph.js';

const PASSWORD = 'correct-horse-battery';

let app: FastifyInstance;
let db: Db;
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

const settingsUrl = () => `/api/agents/${agentId}/ai`;

const patchSettings = (payload: Record<string, unknown>, cookies = ownerJar) =>
  app.inject({ method: 'PATCH', url: settingsUrl(), cookies, payload });

beforeEach(async () => {
  db = await withDb();
  const { accountId } = await createAccountWithOwner(db, {
    company: 'Сафина',
    email: 'owner@example.com',
    name: 'Владелец',
    initials: 'ВЛ',
    password: PASSWORD,
  });
  await addMember(db, {
    company: 'Сафина',
    email: 'member@example.com',
    name: 'Оператор',
    initials: 'ОП',
    password: PASSWORD,
    role: 'member',
  });
  const [agent] = await db
    .insert(agents)
    .values({ accountId, name: 'Сафина', openrouterKey: 'configured' })
    .returning();
  agentId = agent!.id;

  app = buildServer(testEnv(), db, { graph: fakeGraph() });
  await app.ready();
  ownerJar = await login('owner@example.com');
  memberJar = await login('member@example.com');
});

afterEach(async () => {
  await app.close();
});

describe('AI response mode settings', () => {
  it('allows only the owner to change the response mode', async () => {
    const response = await patchSettings({ responseMode: 'live' }, memberJar);

    expect(response.statusCode).toBe(403);
    const [stored] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(stored!.responseMode).toBe('off');
  });

  it('rejects test mode without a selected contact without applying other settings', async () => {
    const response = await patchSettings({ responseMode: 'test', replyLanguage: 'ru' });

    expect(response.statusCode).toBe(400);
    const [stored] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(stored).toMatchObject({ responseMode: 'off', replyLanguage: 'auto', testContactId: null });
  });

  it('rejects a contact owned by another agent without changing the mode', async () => {
    const foreign = await seedForeignContact();

    const response = await patchSettings({ responseMode: 'test', testContactId: foreign.id });

    expect(response.statusCode).toBe(400);
    const [stored] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(stored).toMatchObject({ responseMode: 'off', testContactId: null });
  });

  it('returns the selected owned contact in settings', async () => {
    const [contact] = await db
      .insert(contacts)
      .values({ agentId, name: 'Айгуль', phone: '77001234567' })
      .returning();

    const response = await patchSettings({ responseMode: 'test', testContactId: contact!.id });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      aiEnabled: true,
      responseMode: 'test',
      testContact: { id: contact!.id, name: 'Айгуль', phone: '77001234567' },
    });
  });

  it('retains a selected contact outside test mode and reuses it atomically', async () => {
    const [contact] = await db
      .insert(contacts)
      .values({ agentId, name: null, phone: '77775554433' })
      .returning();

    const selected = await patchSettings({ testContactId: contact!.id });
    expect(selected.statusCode).toBe(200);
    expect(selected.json()).toMatchObject({
      responseMode: 'off',
      testContact: { id: contact!.id, name: null, phone: '77775554433' },
    });

    const enabled = await patchSettings({ responseMode: 'test' });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json()).toMatchObject({ responseMode: 'test', testContact: { id: contact!.id } });

    const disabled = await patchSettings({ responseMode: 'off' });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json()).toMatchObject({
      aiEnabled: false,
      responseMode: 'off',
      testContact: { id: contact!.id },
    });
  });

  it('lists only contacts owned by the agent for the selector', async () => {
    const [owned] = await db
      .insert(contacts)
      .values({ agentId, name: 'Бек', phone: '77010000000' })
      .returning();
    await seedForeignContact();

    const response = await app.inject({
      method: 'GET',
      url: `${settingsUrl()}/test-contacts`,
      cookies: ownerJar,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([{ id: owned!.id, name: 'Бек', phone: '77010000000' }]);
  });
});

async function seedForeignContact(): Promise<typeof contacts.$inferSelect> {
  const { accountId } = await createAccountWithOwner(db, {
    company: 'Чужая компания',
    email: `foreign-${randomUUID()}@example.com`,
    name: 'Другой владелец',
    initials: 'ДВ',
    password: PASSWORD,
  });
  const [agent] = await db.insert(agents).values({ accountId, name: 'Чужой агент' }).returning();
  const [contact] = await db
    .insert(contacts)
    .values({ agentId: agent!.id, name: 'Чужой клиент', phone: '77029999999' })
    .returning();
  return contact!;
}
