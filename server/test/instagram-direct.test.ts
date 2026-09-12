import { createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { agents, capiEvents, capiSettings, contacts, conversations, instagramAccounts, instagramContacts, instagramEvents, messages, notes, stages } from '../src/db/schema.js';
import { applyInstagramPayload, processPendingInstagramEvents } from '../src/lib/instagram/inbound.js';
import { createAccountWithOwner } from '../src/lib/provision.js';
import { decryptSecret, encryptSecret } from '../src/lib/secret-box.js';
import { withDb } from './helpers/db.js';
import { testEnv } from './helpers/env.js';
import { fakeGraph } from './helpers/fake-graph.js';
import { fakeInstagramMessaging } from './helpers/fake-instagram-messaging.js';
import { fakeLinked } from './helpers/fake-linked.js';
import { fakeModel } from './helpers/fake-model.js';
import { sendStageMessage } from '../src/lib/funnel-message.js';
import { queueLead, NON_WHATSAPP } from '../src/lib/capi/enqueue.js';

const env = testEnv();
const key = Buffer.from(env.CREDENTIALS_KEY, 'base64');
let db: Awaited<ReturnType<typeof withDb>>; let app: FastifyInstance; let agentId: string; let jar: Record<string, string>;
let messaging = fakeInstagramMessaging();
const payload = (over: Record<string, unknown> = {}) => ({ object: 'instagram', entry: [{ id: 'ig-business-1', messaging: [{
  sender: { id: 'ig-customer-1' }, recipient: { id: 'ig-business-1' }, timestamp: Date.now(),
  message: { mid: 'ig-message-1', text: 'Здравствуйте', ...over },
}]}] });

beforeEach(async () => {
  db = await withDb();
  const provisioned = await createAccountWithOwner(db, { company: 'Shop', email: 'owner@example.com', name: 'Owner', initials: 'OW', password: 'correct-horse-battery' });
  messaging = fakeInstagramMessaging();
  app = buildServer(env, db, { graph: fakeGraph(), instagramMessaging: messaging }); await app.ready();
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'owner@example.com', password: 'correct-horse-battery' } });
  jar = { [login.cookies[0]!.name]: login.cookies[0]!.value };
  const created = await app.inject({ method: 'POST', url: `/api/accounts/${provisioned.accountId}/agents`, cookies: jar, payload: { name: 'Shop' } });
  agentId = created.json().id;
});
afterEach(async () => { await app.close(); });

describe('Instagram Direct', () => {
  it('connects with an encrypted Page token and never serializes it', async () => {
    const response = await app.inject({ method: 'POST', url: `/api/agents/${agentId}/instagram/connect`, cookies: jar, payload: { code: 'oauth-code' } });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('page-secret'); expect(response.body).not.toContain('oauth-code');
    const [stored] = await db.select().from(instagramAccounts);
    expect(stored!.accessToken).not.toBe('page-secret');
    expect(decryptSecret(stored!.accessToken, key, stored!.instagramUserId)).toBe('page-secret');
    expect(response.json().account).toMatchObject({ username: 'shop', subscribed: true, enabled: true });
    expect(messaging.calls.find((call) => call.method === 'subscribe')?.args).toEqual(['page-1', 'page-secret', env.META_APP_ID]);
  });

  it('asks the owner to select when Meta exposes several accounts', async () => {
    await app.close();
    const messaging = fakeInstagramMessaging([
      { instagramUserId: 'ig-1', username: 'one', pageId: 'p1', pageName: 'One', pageToken: 'one-secret' },
      { instagramUserId: 'ig-2', username: 'two', pageId: 'p2', pageName: 'Two', pageToken: 'two-secret' },
    ]);
    app = buildServer(env, db, { graph: fakeGraph(), instagramMessaging: messaging }); await app.ready();
    const response = await app.inject({ method: 'POST', url: `/api/agents/${agentId}/instagram/connect`, cookies: jar, payload: { code: 'oauth-code' } });
    expect(response.json()).toMatchObject({ account: null, choices: [{ instagramUserId: 'ig-1' }, { instagramUserId: 'ig-2' }] });
    expect(await db.select().from(instagramAccounts)).toEqual([]);
  });

  it('persists a non-ready account before subscribing so an immediate webhook can route', async () => {
    await app.close();
    let visibleDuringSubscription = false;
    messaging = fakeInstagramMessaging(undefined, { subscribe: async () => {
      const [stored] = await db.select().from(instagramAccounts);
      visibleDuringSubscription = stored?.subscribedAt === null;
    } });
    app = buildServer(env, db, { graph: fakeGraph(), instagramMessaging: messaging }); await app.ready();
    const response = await app.inject({ method: 'POST', url: `/api/agents/${agentId}/instagram/connect`, cookies: jar, payload: { code: 'oauth-code' } });
    expect(response.statusCode).toBe(200);
    expect(visibleDuringSubscription).toBe(true);
  });

  it('keeps a failed subscription visibly incomplete', async () => {
    await app.close();
    messaging = fakeInstagramMessaging(undefined, { subscribe: async () => { throw new Error('provider refused page-secret'); } });
    app = buildServer(env, db, { graph: fakeGraph(), instagramMessaging: messaging }); await app.ready();
    const response = await app.inject({ method: 'POST', url: `/api/agents/${agentId}/instagram/connect`, cookies: jar, payload: { code: 'oauth-code' } });
    expect(response.statusCode).toBe(502); expect(response.body).not.toContain('page-secret');
    const [stored] = await db.select().from(instagramAccounts);
    expect(stored!.subscribedAt).toBeNull();
  });

  it('stores one inbound text and one conversation across redelivery', async () => {
    await db.insert(instagramAccounts).values({ agentId, instagramUserId: 'ig-business-1', pageId: 'page-1', username: 'shop', accessToken: encryptSecret('page-secret', key, 'ig-business-1'), subscribedAt: new Date() });
    expect((await applyInstagramPayload(db, payload())).size).toBe(1);
    expect((await applyInstagramPayload(db, payload())).size).toBe(0);
    expect(await db.select().from(contacts)).toHaveLength(1);
    expect(await db.select().from(instagramContacts)).toHaveLength(1);
    expect(await db.select().from(conversations)).toHaveLength(1);
    expect(await db.select().from(messages)).toHaveLength(1);
  });

  it('ignores echoes and does not open a response window', async () => {
    await db.insert(instagramAccounts).values({ agentId, instagramUserId: 'ig-business-1', pageId: 'page-1', username: 'shop', accessToken: encryptSecret('page-secret', key, 'ig-business-1'), subscribedAt: new Date() });
    expect((await applyInstagramPayload(db, payload({ is_echo: true }))).size).toBe(0);
    expect(await db.select().from(conversations)).toEqual([]);
  });

  it('sends an operator reply through Instagram and records acceptance', async () => {
    const [account] = await db.insert(instagramAccounts).values({ agentId, instagramUserId: 'ig-business-1', pageId: 'page-1', username: 'shop', accessToken: encryptSecret('page-secret', key, 'ig-business-1'), subscribedAt: new Date() }).returning();
    const [contact] = await db.insert(contacts).values({ agentId, phone: null }).returning();
    await db.insert(instagramContacts).values({ contactId: contact!.id, agentId, instagramAccountId: account!.id, instagramUserId: 'ig-customer-1', username: 'customer' });
    const [conversation] = await db.insert(conversations).values({ agentId, contactId: contact!.id, instagramAccountId: account!.id, lastInboundAt: new Date() }).returning();
    const response = await app.inject({ method: 'POST', url: `/api/agents/${agentId}/conversations/${conversation!.id}/messages`, cookies: jar, payload: { body: 'Добрый день' } });
    expect(response.statusCode).toBe(200);
    expect(messaging.calls.find((call) => call.method === 'sendText')?.args).toEqual(['page-1', 'page-secret', 'ig-customer-1', 'Добрый день']);
    const [stored] = await db.select().from(messages);
    expect(stored).toMatchObject({ instagramMessageId: expect.any(String), waMessageId: null, author: 'operator' });
  });

  it('rejects an Instagram reply at the 24-hour boundary without calling Meta', async () => {
    const [account] = await db.insert(instagramAccounts).values({ agentId, instagramUserId: 'ig-business-1', pageId: 'page-1', accessToken: encryptSecret('page-secret', key, 'ig-business-1'), subscribedAt: new Date() }).returning();
    const [contact] = await db.insert(contacts).values({ agentId, phone: null }).returning();
    await db.insert(instagramContacts).values({ contactId: contact!.id, agentId, instagramAccountId: account!.id, instagramUserId: 'ig-customer-1' });
    const [conversation] = await db.insert(conversations).values({ agentId, contactId: contact!.id, instagramAccountId: account!.id, lastInboundAt: new Date(Date.now() - 24 * 60 * 60 * 1000) }).returning();
    const response = await app.inject({ method: 'POST', url: `/api/agents/${agentId}/conversations/${conversation!.id}/messages`, cookies: jar, payload: { body: 'Поздно' } });
    expect(response.statusCode).toBe(409);
    expect(messaging.calls.some((call) => call.method === 'sendText')).toBe(false);
  });

  it('sends a stage message through the Instagram transport', async () => {
    const [account] = await db.insert(instagramAccounts).values({ agentId, instagramUserId: 'ig-business-1', pageId: 'page-1', accessToken: encryptSecret('page-secret', key, 'ig-business-1'), subscribedAt: new Date() }).returning();
    const [contact] = await db.insert(contacts).values({ agentId, phone: null, name: 'Айгуль' }).returning();
    await db.insert(instagramContacts).values({ contactId: contact!.id, agentId, instagramAccountId: account!.id, instagramUserId: 'ig-customer-1' });
    const [conversation] = await db.insert(conversations).values({ agentId, contactId: contact!.id, instagramAccountId: account!.id, lastInboundAt: new Date() }).returning();
    const [stage] = await db.select().from(stages).where(eq(stages.agentId, agentId));
    await db.update(stages).set({ autoMessage: 'Здравствуйте, {{name}}' }).where(eq(stages.id, stage!.id));

    await sendStageMessage(db, { graph: fakeGraph(), linked: fakeLinked(), instagramMessaging: messaging, env, key },
      { agentId, conversationId: conversation!.id, stageId: stage!.id });

    expect(messaging.calls.find((call) => call.method === 'sendText')?.args)
      .toEqual(['page-1', 'page-secret', 'ig-customer-1', 'Здравствуйте, Айгуль']);
    const [stored] = await db.select().from(messages);
    expect(stored).toMatchObject({ instagramMessageId: expect.any(String), waMessageId: null, author: 'system' });

    messaging.calls.length = 0;
    await db.update(instagramAccounts).set({ enabled: false }).where(eq(instagramAccounts.id, account!.id));
    await sendStageMessage(db, { graph: fakeGraph(), linked: fakeLinked(), instagramMessaging: messaging, env, key },
      { agentId, conversationId: conversation!.id, stageId: stage!.id });
    expect(messaging.calls.some((call) => call.method === 'sendText')).toBe(false);

    await db.update(instagramAccounts).set({ enabled: true }).where(eq(instagramAccounts.id, account!.id));
    await db.update(conversations).set({ lastInboundAt: new Date(Date.now() - 24 * 60 * 60 * 1000) })
      .where(eq(conversations.id, conversation!.id));
    await sendStageMessage(db, { graph: fakeGraph(), linked: fakeLinked(), instagramMessaging: messaging, env, key },
      { agentId, conversationId: conversation!.id, stageId: stage!.id });
    expect(messaging.calls.some((call) => call.method === 'sendText')).toBe(false);
    expect((await db.select().from(notes)).map((row) => row.body).join(' ')).toContain('окно ответа закрыто');
  });

  it('marks Instagram lead attribution as unsupported instead of sending IGSID to CAPI', async () => {
    const [account] = await db.insert(instagramAccounts).values({ agentId, instagramUserId: 'ig-business-1', pageId: 'page-1', accessToken: encryptSecret('page-secret', key, 'ig-business-1'), subscribedAt: new Date() }).returning();
    const [contact] = await db.insert(contacts).values({ agentId, phone: null }).returning();
    await db.insert(instagramContacts).values({ contactId: contact!.id, agentId, instagramAccountId: account!.id, instagramUserId: 'ig-customer-1' });
    const [qualified] = await db.select().from(stages).where(eq(stages.agentId, agentId));
    await db.update(stages).set({ kind: 'qualified' }).where(eq(stages.id, qualified!.id));
    const [conversation] = await db.insert(conversations).values({ agentId, contactId: contact!.id,
      instagramAccountId: account!.id, stageId: qualified!.id, ctwaClid: 'must-not-be-used' }).returning();
    await db.insert(capiSettings).values({ agentId, datasetId: 'dataset', accessToken: encryptSecret('token', key, agentId), enabled: true });

    await queueLead(db, { agentId, conversationId: conversation!.id });

    const [event] = await db.select().from(capiEvents);
    expect(event).toMatchObject({ status: 'skipped', error: NON_WHATSAPP });
    expect(event!.payload).not.toContain('ig-customer-1');
  });

  it('rejects an unsigned webhook and durably accepts a signed one', async () => {
    const body = JSON.stringify(payload());
    expect((await app.inject({ method: 'POST', url: '/api/instagram/webhook', payload: body, headers: { 'content-type': 'application/json' } })).statusCode).toBe(401);
    const signature = `sha256=${createHmac('sha256', env.META_APP_SECRET).update(body).digest('hex')}`;
    expect((await app.inject({ method: 'POST', url: '/api/instagram/webhook', payload: body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature } })).statusCode).toBe(200);
    expect(await db.select().from(instagramEvents)).toHaveLength(1);
  });

  it('retries a durable event after its account becomes available', async () => {
    await db.insert(instagramEvents).values({ payload: payload() });
    const deps = { graph: fakeGraph(), linked: fakeLinked(), model: fakeModel(), key, env, instagramMessaging: fakeInstagramMessaging() };
    expect(await processPendingInstagramEvents(db, deps)).toEqual({ processed: 0, failed: 1 });
    await db.insert(instagramAccounts).values({ agentId, instagramUserId: 'ig-business-1', pageId: 'page-1', accessToken: encryptSecret('page-secret', key, 'ig-business-1'), subscribedAt: new Date() });
    expect(await processPendingInstagramEvents(db, deps)).toEqual({ processed: 1, failed: 0 });
    expect(await db.select().from(messages)).toHaveLength(1);
    const [event] = await db.select().from(instagramEvents);
    expect(event!.conversationIds).toHaveLength(1);
    expect(event!.processedAt).not.toBeNull();
  });

  it('leases an event so concurrent drains apply it once', async () => {
    await db.insert(instagramAccounts).values({ agentId, instagramUserId: 'ig-business-1', pageId: 'page-1', accessToken: encryptSecret('page-secret', key, 'ig-business-1'), subscribedAt: new Date() });
    await db.insert(instagramEvents).values({ payload: payload() });
    const deps = { graph: fakeGraph(), linked: fakeLinked(), model: fakeModel(), key, env, instagramMessaging: fakeInstagramMessaging() };
    const results = await Promise.all([processPendingInstagramEvents(db, deps), processPendingInstagramEvents(db, deps)]);
    expect(results.reduce((sum, result) => sum + result.processed, 0)).toBe(1);
    expect(await db.select().from(messages)).toHaveLength(1);
  });

  it('does not resend after a recorded AI reply when event completion is retried', async () => {
    await db.update(agents).set({ aiEnabled: true, responseMode: 'live', openrouterKey: 'present' });
    const [account] = await db.insert(instagramAccounts).values({ agentId, instagramUserId: 'ig-business-1', pageId: 'page-1', accessToken: encryptSecret('secret', key, 'ig-business-1'), subscribedAt: new Date() }).returning();
    const [contact] = await db.insert(contacts).values({ agentId, phone: null }).returning();
    await db.insert(instagramContacts).values({ contactId: contact!.id, agentId, instagramAccountId: account!.id, instagramUserId: 'sender' });
    const [conversation] = await db.insert(conversations).values({ agentId, contactId: contact!.id, instagramAccountId: account!.id, lastInboundAt: new Date() }).returning();
    await db.insert(messages).values([
      { conversationId: conversation!.id, instagramMessageId: 'incoming', direction: 'in', author: 'client', kind: 'text', body: 'Hello', sentAt: new Date(Date.now() - 1000) },
      { conversationId: conversation!.id, instagramMessageId: 'already-sent', direction: 'out', author: 'ai', kind: 'text', body: 'Hi', sentAt: new Date() },
    ]);
    await db.insert(instagramEvents).values({ payload: payload(), conversationIds: [conversation!.id] });
    const provider = fakeInstagramMessaging(); const model = fakeModel();
    expect(await processPendingInstagramEvents(db, { graph: fakeGraph(), linked: fakeLinked(), model, key, env, instagramMessaging: provider })).toEqual({ processed: 1, failed: 0 });
    expect(model.calls).toHaveLength(0);
    expect(provider.calls.filter((call) => call.method === 'sendText')).toHaveLength(0);
  });

  it('keeps the same sender id separate for two Instagram accounts', async () => {
    await db.insert(instagramAccounts).values([
      { agentId, instagramUserId: 'ig-business-1', pageId: 'page-1', accessToken: encryptSecret('one', key, 'ig-business-1'), subscribedAt: new Date() },
      { agentId, instagramUserId: 'ig-business-2', pageId: 'page-2', accessToken: encryptSecret('two', key, 'ig-business-2'), subscribedAt: new Date() },
    ]);
    await applyInstagramPayload(db, payload());
    const second = payload(); second.entry[0]!.id = 'ig-business-2'; second.entry[0]!.messaging[0]!.recipient.id = 'ig-business-2'; second.entry[0]!.messaging[0]!.message.mid = 'ig-message-2';
    await applyInstagramPayload(db, second);
    expect(await db.select().from(instagramContacts)).toHaveLength(2);
    expect(await db.select().from(conversations)).toHaveLength(2);
  });

  it('rejects cross-tenant Instagram contact ownership', async () => {
    const other = await createAccountWithOwner(db, { company: 'Other', email: 'other@example.com', name: 'Other', initials: 'OT', password: 'correct-horse-battery' });
    const [otherAgent] = await db.insert(agents).values({ accountId: other.accountId, name: 'Other' }).returning();
    const [account] = await db.insert(instagramAccounts).values({ agentId, instagramUserId: 'ig-business-1', pageId: 'page-1', accessToken: encryptSecret('secret', key, 'ig-business-1') }).returning();
    const [foreignContact] = await db.insert(contacts).values({ agentId: otherAgent!.id, phone: null }).returning();
    await expect(db.insert(instagramContacts).values({ contactId: foreignContact!.id, agentId, instagramAccountId: account!.id, instagramUserId: 'sender' })).rejects.toThrow();
  });

  it('does not expose a provider error containing a credential', async () => {
    await app.close();
    messaging = fakeInstagramMessaging([], { discover: async () => { throw new Error('bad page-secret oauth-code'); } });
    app = buildServer(env, db, { graph: fakeGraph(), instagramMessaging: messaging }); await app.ready();
    const response = await app.inject({ method: 'POST', url: `/api/agents/${agentId}/instagram/connect`, cookies: jar, payload: { code: 'oauth-code' } });
    expect(response.statusCode).toBe(502);
    expect(response.body).not.toContain('page-secret'); expect(response.body).not.toContain('oauth-code');
  });
});
