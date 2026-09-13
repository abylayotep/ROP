import { randomUUID } from 'node:crypto';
import { asc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import type { Db } from '../src/db/client.js';
import {
  accounts,
  agents,
  aiReplies,
  aiSandboxSessions,
  aiSandboxTurns,
  contacts,
  conversations,
  messages,
  orders,
} from '../src/db/schema.js';
import { withDb } from './helpers/db.js';
import { testEnv } from './helpers/env.js';
import { fakeGraph } from './helpers/fake-graph.js';
import { fakeLinked } from './helpers/fake-linked.js';
import { fakeModel, type FakeModel } from './helpers/fake-model.js';
import { addMember, createAccountWithOwner } from '../src/lib/provision.js';
import { encryptSecret } from '../src/lib/secret-box.js';

async function seedAgent(db: Db, accountName: string, agentName = accountName) {
  const [account] = await db.insert(accounts).values({ name: accountName }).returning();
  const [agent] = await db
    .insert(agents)
    .values({ accountId: account!.id, name: agentName })
    .returning();
  return { accountId: account!.id, agentId: agent!.id };
}

let db: Awaited<ReturnType<typeof withDb>>;

beforeEach(async () => {
  db = await withDb();
});

describe('AI sandbox persistence', () => {
  it('stores sandbox state without creating production CRM or messaging rows', async () => {
    const owner = await seedAgent(db, 'Northwind');
    const [session] = await db
      .insert(aiSandboxSessions)
      .values({ ...owner, title: 'Delivery test', phone: '77001234567' })
      .returning();

    await db.insert(aiSandboxTurns).values({
      ...owner,
      sessionId: session!.id,
      revision: 1,
      userText: 'How much is delivery?',
      reply: 'Delivery is free.',
      configVersion: 3,
      model: 'openai/gpt-4o-mini',
      sourceIds: ['knowledge-item-1'],
      stageId: '11111111-1111-4111-8111-111111111111',
      stageName: 'Qualified',
      fields: [{ id: 'budget', name: 'Budget', value: '50000' }],
      outcome: 'sent',
    });

    expect(await db.select().from(aiSandboxSessions)).toHaveLength(1);
    expect(await db.select().from(aiSandboxTurns)).toHaveLength(1);
    expect(await db.select().from(contacts)).toEqual([]);
    expect(await db.select().from(conversations)).toEqual([]);
    expect(await db.select().from(messages)).toEqual([]);
    expect(await db.select().from(orders)).toEqual([]);
    expect(await db.select().from(aiReplies)).toEqual([]);
  });

  it('rejects a session or turn whose tenant and agent ownership do not match', async () => {
    const first = await seedAgent(db, 'First tenant');
    const second = await seedAgent(db, 'Second tenant');

    await expect(
      db.insert(aiSandboxSessions).values({
        accountId: first.accountId,
        agentId: second.agentId,
        title: 'Foreign session',
      }),
    ).rejects.toThrow();

    const [session] = await db
      .insert(aiSandboxSessions)
      .values({ ...first, title: 'Owned session' })
      .returning();

    await expect(
      db.insert(aiSandboxTurns).values({
        ...second,
        sessionId: session!.id,
        revision: 1,
        userText: 'Cross-tenant turn',
        configVersion: 1,
        model: 'openai/gpt-4o-mini',
        outcome: 'failed',
      }),
    ).rejects.toThrow();
  });

  it('starts at revision zero and advances the persisted session state atomically', async () => {
    const owner = await seedAgent(db, 'Revision tenant');
    const [created] = await db
      .insert(aiSandboxSessions)
      .values({ ...owner, title: 'Revision test' })
      .returning();

    expect(created).toMatchObject({
      revision: 0,
      stageId: null,
      stageName: null,
      fields: [],
      outcome: null,
      handoff: null,
    });

    const [advanced] = await db
      .update(aiSandboxSessions)
      .set({
        revision: sql`${aiSandboxSessions.revision} + 1`,
        stageId: '22222222-2222-4222-8222-222222222222',
        stageName: 'Qualified',
        fields: [{ id: 'city', name: 'City', value: 'Almaty' }],
        outcome: 'sent',
        handoff: null,
      })
      .where(eq(aiSandboxSessions.id, created!.id))
      .returning();

    expect(advanced).toMatchObject({
      revision: 1,
      stageId: '22222222-2222-4222-8222-222222222222',
      stageName: 'Qualified',
      fields: [{ id: 'city', name: 'City', value: 'Almaty' }],
      outcome: 'sent',
      handoff: null,
    });
  });

  it('orders turns by revision and refuses two turns at the same revision', async () => {
    const owner = await seedAgent(db, 'Ordered tenant');
    const [session] = await db
      .insert(aiSandboxSessions)
      .values({ ...owner, title: 'Ordered turns' })
      .returning();
    const turn = (revision: number, userText: string) => ({
      ...owner,
      sessionId: session!.id,
      revision,
      userText,
      configVersion: 1,
      model: 'openai/gpt-4o-mini',
      outcome: 'sent',
    });

    await db.insert(aiSandboxTurns).values(turn(2, 'Second'));
    await db.insert(aiSandboxTurns).values(turn(1, 'First'));

    const rows = await db
      .select({ revision: aiSandboxTurns.revision, userText: aiSandboxTurns.userText })
      .from(aiSandboxTurns)
      .where(eq(aiSandboxTurns.sessionId, session!.id))
      .orderBy(asc(aiSandboxTurns.revision));
    expect(rows).toEqual([
      { revision: 1, userText: 'First' },
      { revision: 2, userText: 'Second' },
    ]);
    await expect(db.insert(aiSandboxTurns).values(turn(2, 'Duplicate'))).rejects.toThrow();
  });

  it('cascades turns with their session and sessions with their agent', async () => {
    const owner = await seedAgent(db, 'Cascade tenant');
    const createSession = async (title: string) => {
      const [session] = await db
        .insert(aiSandboxSessions)
        .values({ ...owner, title })
        .returning();
      await db.insert(aiSandboxTurns).values({
        ...owner,
        sessionId: session!.id,
        revision: 1,
        userText: 'Hello',
        configVersion: 1,
        model: 'openai/gpt-4o-mini',
        outcome: 'sent',
      });
      return session!;
    };

    const first = await createSession('Delete directly');
    await db.delete(aiSandboxSessions).where(eq(aiSandboxSessions.id, first.id));
    expect(await db.select().from(aiSandboxTurns)).toEqual([]);

    await createSession('Delete through agent');
    await db.delete(agents).where(eq(agents.id, owner.agentId));
    expect(await db.select().from(aiSandboxSessions)).toEqual([]);
    expect(await db.select().from(aiSandboxTurns)).toEqual([]);
  });
});

describe('AI sandbox session routes', () => {
  const env = testEnv();
  const password = 'correct-horse-battery';
  let app: FastifyInstance;
  let agentId: string;
  let ownerCookies: Record<string, string>;
  let memberCookies: Record<string, string>;
  let model: FakeModel;

  const base = () => `/api/agents/${agentId}/ai/sandbox/sessions`;
  const request = (method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>,
    cookies = ownerCookies) => app.inject({ method, url, payload, cookies });
  const create = (payload: Record<string, unknown> = {}) => request('POST', base(), payload);

  async function login(email: string) {
    const response = await app.inject({ method: 'POST', url: '/api/auth/login',
      payload: { email, password } });
    const cookie = response.cookies[0]!;
    return { [cookie.name]: cookie.value };
  }

  beforeEach(async () => {
    const { accountId } = await createAccountWithOwner(db, {
      company: 'Simulator routes', email: 'sandbox-owner@example.com', name: 'Owner',
      initials: 'OW', password,
    });
    await addMember(db, {
      company: 'Simulator routes', email: 'sandbox-member@example.com', name: 'Member',
      initials: 'MB', password, role: 'member',
    });
    agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, accountId, name: 'Sales',
      openrouterKey: encryptSecret('sk-sandbox-api', Buffer.from(env.CREDENTIALS_KEY, 'base64'), agentId),
    });
    model = fakeModel(JSON.stringify({ reply: 'Hello!', stageId: null, fields: {},
      handoff: null, usedItemIds: [] }));
    app = buildServer(env, db, { model, graph: fakeGraph(), linked: fakeLinked() });
    await app.ready();
    ownerCookies = await login('sandbox-owner@example.com');
    memberCookies = await login('sandbox-member@example.com');
  });

  afterEach(async () => { if (app) await app.close(); });

  it('creates a revision-zero session and lists newest updates first', async () => {
    const first = await create({ title: ' First test ', phone: ' 77001234567 ' });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ title: 'First test', phone: '77001234567',
      revision: 0, stageId: null, fields: [], outcome: null });
    const second = await create({});
    expect(second.statusCode).toBe(201);
    const listed = await request('GET', base());
    expect(listed.statusCode).toBe(200);
    expect(listed.json().map((session: { id: string }) => session.id))
      .toEqual([second.json().id, first.json().id]);
  });

  it('returns a scoped detail with turns in ascending revision order', async () => {
    const created = (await create()).json();
    const owner = (await db.select().from(agents).where(eq(agents.id, agentId)))[0]!;
    for (const [revision, userText] of [[2, 'Second'], [1, 'First']] as const) {
      await db.insert(aiSandboxTurns).values({ accountId: owner.accountId, agentId,
        sessionId: created.id, revision, userText, configVersion: 1,
        model: 'openai/gpt-4o-mini', outcome: 'sent' });
    }
    const detail = await request('GET', `${base()}/${created.id}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().turns.map((turn: { userText: string }) => turn.userText))
      .toEqual(['First', 'Second']);
  });

  it('sends a turn, advances the session and keeps the old one-shot route working', async () => {
    const created = (await create()).json();
    const sent = await request('POST', `${base()}/${created.id}/turns`,
      { text: 'Hi', revision: 0 });
    expect(sent.statusCode).toBe(200);
    expect(sent.json()).toMatchObject({ revision: 1, userText: 'Hi', reply: 'Hello!' });
    const detail = await request('GET', `${base()}/${created.id}`);
    expect(detail.json()).toMatchObject({ revision: 1,
      turns: [{ revision: 1, userText: 'Hi', reply: 'Hello!' }] });
    const oldRoute = await request('POST', `/api/agents/${agentId}/ai/sandbox`, { text: 'Hi' });
    expect(oldRoute.statusCode).toBe(409);
    expect(oldRoute.json().message).toContain('номер WhatsApp');
  });

  it('uses the production separate-CRM setting for browser turns', async () => {
    await app.close();
    model = fakeModel(
      JSON.stringify({ stageId: null, summary: 'Client greeted the agent.', confidence: 90,
        profile: {}, fields: {}, checkout: null }),
      JSON.stringify({ reply: 'Hello!', stageId: null, fields: {}, handoff: null,
        usedItemIds: [] }),
    );
    app = buildServer(env, db, { model, graph: fakeGraph(), linked: fakeLinked(), crmEnabled: true });
    await app.ready();
    const created = (await create()).json();

    const sent = await request('POST', `${base()}/${created.id}/turns`,
      { text: 'Hello', revision: 0 });

    expect(sent.statusCode).toBe(200);
    expect(sent.json()).toMatchObject({ reply: 'Hello!', effectSource: 'crm' });
    expect(model.calls).toHaveLength(2);
    expect((await request('GET', `${base()}/${created.id}`)).json().turns[0])
      .toMatchObject({ effectSource: 'crm' });
    expect(await db.select().from(orders)).toEqual([]);
  });

  it('rejects blank, oversized and invalid-revision messages before calling the model', async () => {
    const created = (await create()).json();
    for (const payload of [
      { text: '   ', revision: 0 }, { text: 'x'.repeat(4_001), revision: 0 },
      { text: 'Hi', revision: -1 }, { text: 'Hi', revision: 0.5 },
      { text: 'Hi' },
    ]) {
      const response = await request('POST', `${base()}/${created.id}/turns`, payload);
      expect(response.statusCode).toBe(400);
    }
    expect(model.calls).toHaveLength(0);
  });

  it.each([
    { length: 1, status: 200, revision: 1, turns: 1 },
    { length: 4_000, status: 200, revision: 1, turns: 1 },
    { length: 4_001, status: 400, revision: 0, turns: 0 },
  ])('answers $status for a customer message of $length characters', async ({
    length, status, revision, turns,
  }) => {
    const created = (await create()).json();
    const sent = await request('POST', `${base()}/${created.id}/turns`,
      { text: 'x'.repeat(length), revision: 0 });
    expect(sent.statusCode).toBe(status);
    const detail = (await request('GET', `${base()}/${created.id}`)).json();
    expect(detail.revision).toBe(revision);
    expect(detail.turns).toHaveLength(turns);
  });

  it('accepts twenty turns within a minute and rejects the twenty-first with 429', async () => {
    const created = (await create()).json();
    for (let revision = 0; revision < 20; revision += 1) {
      const sent = await request('POST', `${base()}/${created.id}/turns`,
        { text: 'Hi', revision });
      expect(sent.statusCode).toBe(200);
      expect(sent.json().revision).toBe(revision + 1);
    }
    const refused = await request('POST', `${base()}/${created.id}/turns`,
      { text: 'Hi', revision: 20 });
    expect(refused.statusCode).toBe(429);
    const detail = (await request('GET', `${base()}/${created.id}`)).json();
    expect(detail.revision).toBe(20);
    expect(detail.turns).toHaveLength(20);
  }, 20_000);

  it('returns 409 for a stale turn without changing stored revision', async () => {
    const created = (await create()).json();
    expect((await request('POST', `${base()}/${created.id}/turns`,
      { text: 'First', revision: 0 })).statusCode).toBe(200);
    const stale = await request('POST', `${base()}/${created.id}/turns`,
      { text: 'Again', revision: 0 });
    expect(stale.statusCode).toBe(409);
    expect((await request('GET', `${base()}/${created.id}`)).json().turns).toHaveLength(1);
    expect(model.calls).toHaveLength(1);
  });

  it('returns 404 for malformed or missing session identifiers', async () => {
    for (const id of ['not-a-uuid', randomUUID()]) {
      expect((await request('GET', `${base()}/${id}`)).statusCode).toBe(404);
      expect((await request('POST', `${base()}/${id}/turns`,
        { text: 'Hi', revision: 0 })).statusCode).toBe(404);
    }
  });

  it('keeps every route owner-only and hides foreign tenant resources', async () => {
    const created = (await create()).json();
    for (const [method, url, payload] of [
      ['GET', base(), undefined], ['POST', base(), {}],
      ['GET', `${base()}/${created.id}`, undefined],
      ['POST', `${base()}/${created.id}/turns`, { text: 'Hi', revision: 0 }],
    ] as const) {
      expect((await request(method, url, payload, memberCookies)).statusCode).toBe(403);
    }
    const foreign = await createAccountWithOwner(db, {
      company: 'Foreign', email: 'foreign-sandbox@example.com', name: 'Foreign',
      initials: 'FO', password,
    });
    const [foreignAgent] = await db.insert(agents)
      .values({ accountId: foreign.accountId, name: 'Foreign agent' }).returning();
    const [foreignSession] = await db.insert(aiSandboxSessions).values({
      accountId: foreign.accountId, agentId: foreignAgent!.id, title: 'Private',
    }).returning();
    expect((await request('GET', `${base()}/${foreignSession!.id}`)).statusCode).toBe(404);
    expect((await request('POST', `${base()}/${foreignSession!.id}/turns`,
      { text: 'Hi', revision: 0 })).statusCode).toBe(404);
    expect((await request('GET', `/api/agents/${foreignAgent!.id}/ai/sandbox/sessions`))
      .statusCode).toBe(404);
  });
});
