import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api/server.js';
import { accountMembers, agents, contacts, conversations, messages, whatsappNumbers } from '../src/db/schema.js';
import { createAccountWithOwner } from '../src/lib/provision.js';
import { withDb } from './helpers/db.js';
import { testEnv } from './helpers/env.js';
import { fakeLinked, type FakeLinked } from './helpers/fake-linked.js';

const PASSWORD = 'correct-horse-battery';
let app: FastifyInstance;
let db: Awaited<ReturnType<typeof withDb>>;
let agentId: string;
let numberId: string;
let ownerJar: Record<string, string>;
let linked: FakeLinked;

async function login(email: string) {
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: PASSWORD } });
  const cookie = response.cookies[0]!;
  return { [cookie.name]: cookie.value };
}

beforeEach(async () => {
  db = await withDb();
  linked = fakeLinked({ requestHistory: vi.fn(async () => 'requested-history') });
  app = buildServer(testEnv(), db, { linked, historyPaceMs: 0, historyTimeoutMs: 100 });
  await app.ready();
  const owner = await createAccountWithOwner(db, { company: 'History', email: 'owner@history.test', name: 'Owner', initials: 'OW', password: PASSWORD });
  const [agent] = await db.insert(agents).values({ accountId: owner.accountId, name: 'Agent' }).returning();
  agentId = agent!.id;
  const [number] = await db.insert(whatsappNumbers).values({ agentId, displayPhone: '+7700', connectionKind: 'linked', linkedJid: '7700@s.whatsapp.net', linkedState: 'open' }).returning();
  numberId = number!.id;
  linked.setOpen(numberId, true);
  ownerJar = await login('owner@history.test');
});

afterEach(async () => app.close());

async function seedAnchor() {
  const [contact] = await db.insert(contacts).values({ agentId, phone: '77011234567' }).returning();
  const [conversation] = await db.insert(conversations).values({ agentId, contactId: contact!.id, whatsappNumberId: numberId, lastMessageAt: new Date('2026-09-01T00:00:00Z') }).returning();
  await db.insert(messages).values({ conversationId: conversation!.id, waMessageId: 'anchor-1', direction: 'in', author: 'client', kind: 'text', body: 'hello', sentAt: new Date('2026-08-01T00:00:00Z') });
}

describe('on-demand WhatsApp history API', () => {
  it('exposes availability to an account member but reserves start for the owner', async () => {
    await seedAnchor();
    await db.insert(accountMembers).values({ accountId: (await db.select().from(agents))[0]!.accountId, userId: (await createAccountWithOwner(db, { company: 'Member', email: 'member@history.test', name: 'Member', initials: 'ME', password: PASSWORD })).userId, role: 'member' });
    const memberJar = await login('member@history.test');
    const status = await app.inject({ method: 'GET', url: `/api/agents/${agentId}/whatsapp/history`, cookies: memberJar });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ connectedNumbers: 1, availableChats: 1, run: null });
    const start = await app.inject({ method: 'POST', url: `/api/agents/${agentId}/whatsapp/history`, cookies: memberJar, payload: { limit: 100 } });
    expect(start.statusCode).toBe(403);
  });

  it('requests at most 50 messages from the oldest stored WhatsApp anchor in each chat', async () => {
    await seedAnchor();
    const response = await app.inject({ method: 'POST', url: `/api/agents/${agentId}/whatsapp/history`, cookies: ownerJar, payload: { limit: 100 } });
    expect(response.statusCode).toBe(200);
    await vi.waitFor(() => expect(linked.calls.some((call) => call.method === 'requestHistory')).toBe(true));
    const call = linked.calls.findLast((entry) => entry.method === 'requestHistory')!;
    expect(call.args).toEqual([numberId, 50, { id: 'anchor-1', remoteJid: '77011234567@s.whatsapp.net', fromMe: false }, new Date('2026-08-01T00:00:00Z').getTime()]);
  });

  it('rejects a run before the first usable history has supplied an anchor', async () => {
    const response = await app.inject({ method: 'POST', url: `/api/agents/${agentId}/whatsapp/history`, cookies: ownerJar, payload: { limit: 200 } });
    expect(response.statusCode).toBe(409);
    expect(response.json().message).toContain('Первичная история ещё не получена');
  });

  it('hides another tenant agent on both history routes without contacting WhatsApp', async () => {
    const stranger = await createAccountWithOwner(db, { company: 'Other', email: 'other@history.test', name: 'Other', initials: 'OT', password: PASSWORD });
    const [otherAgent] = await db.insert(agents).values({ accountId: stranger.accountId, name: 'Other agent' }).returning();
    const get = await app.inject({ method: 'GET', url: `/api/agents/${otherAgent!.id}/whatsapp/history`, cookies: ownerJar });
    const post = await app.inject({ method: 'POST', url: `/api/agents/${otherAgent!.id}/whatsapp/history`, cookies: ownerJar, payload: { limit: 100 } });
    expect(get.statusCode).toBe(404);
    expect(post.statusCode).toBe(404);
    expect(linked.calls.filter((call) => call.method === 'requestHistory')).toHaveLength(0);
  });

  it('rejects any limit other than 100 or 200', async () => {
    await seedAnchor();
    const response = await app.inject({ method: 'POST', url: `/api/agents/${agentId}/whatsapp/history`, cookies: ownerJar, payload: { limit: 201 } });
    expect(response.statusCode).toBe(400);
    expect(linked.calls.filter((call) => call.method === 'requestHistory')).toHaveLength(0);
  });

  it('rejects a stored open number when its runtime socket is offline', async () => {
    await seedAnchor();
    linked.setOpen(numberId, false);
    const response = await app.inject({ method: 'POST', url: `/api/agents/${agentId}/whatsapp/history`, cookies: ownerJar, payload: { limit: 100 } });
    expect(response.statusCode).toBe(409);
    expect(response.json().message).toContain('сейчас недоступен');
  });

  it('excludes disabled linked numbers from availability', async () => {
    await seedAnchor();
    await db.update(whatsappNumbers).set({ enabled: false });
    const response = await app.inject({ method: 'GET', url: `/api/agents/${agentId}/whatsapp/history`, cookies: ownerJar });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ connectedNumbers: 0, availableChats: 0 });
  });
});
