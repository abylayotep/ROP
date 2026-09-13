import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';
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
let ownerUserId: string;
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

async function waitForDatabaseState(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out while forcing the settings update race');
}

async function queryWaitsOn(
  table: 'agents' | 'contacts',
  lock: 'share' | 'update',
): Promise<boolean> {
  const rows = await db.execute(sql`
    select exists (
      select 1 from pg_stat_activity
      where datname = current_database()
        and state = 'active'
        and wait_event_type = 'Lock'
        and query like ${`%from "${table}"%for ${lock}%`}
    ) as waiting
  `);
  return Boolean([...rows][0]?.waiting);
}

async function queryWaitsOnAutomationLock(): Promise<boolean> {
  const rows = await db.execute(sql`
    select exists (
      select 1 from pg_stat_activity
      where datname = current_database()
        and state = 'active'
        and wait_event_type = 'Lock'
        and query like '%pg_advisory_xact_lock%'
    ) as waiting
  `);
  return Boolean([...rows][0]?.waiting);
}

beforeEach(async () => {
  db = await withDb();
  const { accountId, userId } = await createAccountWithOwner(db, {
    company: 'Сафина',
    email: 'owner@example.com',
    name: 'Владелец',
    initials: 'ВЛ',
    password: PASSWORD,
  });
  ownerUserId = userId;
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
  it('lets only the owner enable independent CRM without changing reply scope', async () => {
    expect((await patchSettings({crmAnalysisMode:'independent'},memberJar)).statusCode).toBe(403);
    const response=await patchSettings({crmAnalysisMode:'independent'});
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({crmAnalysisMode:'independent',responseMode:'off',aiEnabled:false});
    const [stored]=await db.select().from(agents).where(eq(agents.id,agentId));
    expect(stored).toMatchObject({crmAnalysisMode:'independent',responseMode:'off',aiEnabled:false});
  });
  it('rejects an unknown CRM mode without a partial update', async () => {
    const response=await patchSettings({crmAnalysisMode:'send_anyway',replyLanguage:'ru'});
    expect(response.statusCode).toBe(400);
    const [stored]=await db.select().from(agents).where(eq(agents.id,agentId));
    expect(stored).toMatchObject({crmAnalysisMode:'follow_ai',replyLanguage:'auto'});
  });
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

  it('records the actor and the previous and new response scope atomically', async () => {
    const [contact] = await db
      .insert(contacts)
      .values({ agentId, name: 'Айгуль', phone: '77001234567' })
      .returning();

    const relation = await db.execute(sql`
      select to_regclass('public.agent_response_mode_changes')::text as name
    `);
    expect([...relation][0]?.name).toBe('agent_response_mode_changes');

    const response = await patchSettings({ responseMode: 'test', testContactId: contact!.id });

    expect(response.statusCode).toBe(200);
    const rows = await db.execute(sql`
      select
        agent_id as "agentId",
        actor_user_id as "actorUserId",
        old_response_mode as "oldResponseMode",
        old_test_contact_id as "oldTestContactId",
        new_response_mode as "newResponseMode",
        new_test_contact_id as "newTestContactId"
      from agent_response_mode_changes
      where agent_id = ${agentId}::uuid
    `);
    expect([...rows]).toEqual([
      {
        agentId,
        actorUserId: ownerUserId,
        oldResponseMode: 'off',
        oldTestContactId: null,
        newResponseMode: 'test',
        newTestContactId: contact!.id,
      },
    ]);
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

  it('serializes concurrent mode and contact updates against the latest agent row', async () => {
    const [contact] = await db
      .insert(contacts)
      .values({ agentId, name: 'Айгуль', phone: '77001234567' })
      .returning();
    await db
      .update(agents)
      .set({ responseMode: 'off', testContactId: contact!.id })
      .where(eq(agents.id, agentId));

    let releaseContact!: () => void;
    let contactLocked!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseContact = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      contactLocked = resolve;
    });
    const holder = db.transaction(async (tx) => {
      await tx
        .select({ id: contacts.id })
        .from(contacts)
        .where(eq(contacts.id, contact!.id))
        .for('update');
      contactLocked();
      await release;
    });

    await locked;
    let enableTest: ReturnType<typeof patchSettings> | undefined;
    let clearContact: ReturnType<typeof patchSettings> | undefined;
    try {
      enableTest = patchSettings({ responseMode: 'test' });
      await waitForDatabaseState(() => queryWaitsOn('contacts', 'share'));
      clearContact = patchSettings({ testContactId: null });
      await waitForDatabaseState(async () => {
        const [stored] = await db
          .select({ testContactId: agents.testContactId })
          .from(agents)
          .where(eq(agents.id, agentId));
        return stored!.testContactId === null || queryWaitsOnAutomationLock();
      });
    } finally {
      releaseContact();
    }

    await holder;
    const [enabled, cleared] = await Promise.all([enableTest!, clearContact!]);
    expect(enabled.statusCode).toBe(200);
    expect(cleared.statusCode).toBe(400);
    const [stored] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(stored).toMatchObject({ responseMode: 'test', testContactId: contact!.id });
  });

  it.each([
    { aiEnabled: true, before: 'off' as const, responseMode: 'live' as const },
    { aiEnabled: false, before: 'live' as const, responseMode: 'off' as const },
  ])('maps legacy aiEnabled=$aiEnabled to $responseMode', async ({ aiEnabled, before, responseMode }) => {
    await db
      .update(agents)
      .set({ aiEnabled: !aiEnabled, responseMode: before })
      .where(eq(agents.id, agentId));

    const response = await patchSettings({ aiEnabled });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ aiEnabled, responseMode });
    const [stored] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(stored).toMatchObject({ aiEnabled, responseMode });
  });

  it.each([
    { aiEnabled: false, responseMode: 'live' as const, expectedEnabled: true },
    { aiEnabled: true, responseMode: 'off' as const, expectedEnabled: false },
  ])(
    'lets explicit $responseMode mode override legacy aiEnabled=$aiEnabled',
    async ({ aiEnabled, responseMode, expectedEnabled }) => {
      const response = await patchSettings({ aiEnabled, responseMode });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ aiEnabled: expectedEnabled, responseMode });
      const [stored] = await db.select().from(agents).where(eq(agents.id, agentId));
      expect(stored).toMatchObject({ aiEnabled: expectedEnabled, responseMode });
    },
  );

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
