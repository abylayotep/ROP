# Task 9, step 2: the test file

The full contents of `server/test/conversations.test.ts`. It lives beside
[task 9](2026-09-02-whatsapp-task-9-conversations-api.md) so that neither file crosses the
five-hundred-line limit this repository keeps for documents people maintain.

```ts
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import {
  accountMembers,
  agents,
  contacts,
  conversations,
  messages,
  whatsappNumbers,
} from '../src/db/schema.js';
import { createAccountWithOwner } from '../src/lib/provision.js';
import { encryptSecret } from '../src/lib/secret-box.js';
import { GraphError } from '../src/lib/whatsapp/graph.js';
import { withDb } from './helpers/db.js';
import { testEnv } from './helpers/env.js';
import { fakeGraph, type FakeGraph } from './helpers/fake-graph.js';

const env = testEnv({ MEDIA_DIR: 'var/media-test' });
const key = Buffer.from(env.CREDENTIALS_KEY, 'base64');
const PASSWORD = 'correct-horse-battery';
const DAY = 24 * 60 * 60 * 1000;

let app: FastifyInstance;
let db: Awaited<ReturnType<typeof withDb>>;
let graph: FakeGraph;
let agentId: string;
let accountId: string;
let numberId: string;
let conversationId: string;
let jar: Record<string, string>;

async function login(email = 'owner@example.com') {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: PASSWORD },
  });
  const cookie = res.cookies[0]!;
  return { [cookie.name]: cookie.value };
}

/** Rebuilds the server with a different Graph client, keeping the session valid. */
async function withGraph(next: FakeGraph) {
  graph = next;
  app = buildServer(env, db, { graph });
  await app.ready();
  jar = await login();
}

async function seedMessage(values: Partial<typeof messages.$inferInsert> = {}) {
  const [message] = await db
    .insert(messages)
    .values({
      conversationId,
      waMessageId: `wamid.${Math.random().toString(36).slice(2)}`,
      direction: 'in',
      author: 'client',
      kind: 'text',
      body: 'Сәлеметсіз бе',
      sentAt: new Date(),
      ...values,
    })
    .returning();
  return message!;
}

beforeEach(async () => {
  db = await withDb();
  await withGraph(fakeGraph());

  const created = await createAccountWithOwner(db, {
    company: 'Сафина',
    email: 'owner@example.com',
    name: 'Владелец',
    initials: 'ВЛ',
    password: PASSWORD,
  });
  accountId = created.accountId;

  const [agent] = await db.insert(agents).values({ accountId, name: 'Сафина' }).returning();
  agentId = agent!.id;

  const [number] = await db
    .insert(whatsappNumbers)
    .values({
      agentId,
      phoneNumberId: '136',
      wabaId: '932',
      displayPhone: '+7 708 580 79 32',
      accessToken: encryptSecret('EAAG-token', key),
    })
    .returning();
  numberId = number!.id;

  const [contact] = await db
    .insert(contacts)
    .values({ agentId, phone: '77771234567', name: 'Айгерім' })
    .returning();

  const [conversation] = await db
    .insert(conversations)
    .values({
      agentId,
      contactId: contact!.id,
      whatsappNumberId: numberId,
      lastInboundAt: new Date(),
      lastMessageAt: new Date(),
    })
    .returning();
  conversationId = conversation!.id;

  jar = await login();
});

afterEach(async () => {
  await rm(env.MEDIA_DIR, { recursive: true, force: true });
});

const list = () =>
  app.inject({ method: 'GET', url: `/api/agents/${agentId}/conversations`, cookies: jar });

const thread = (id = conversationId) =>
  app.inject({ method: 'GET', url: `/api/agents/${agentId}/conversations/${id}`, cookies: jar });

const answer = (body: unknown, id = conversationId) =>
  app.inject({
    method: 'POST',
    url: `/api/agents/${agentId}/conversations/${id}/messages`,
    cookies: jar,
    payload: body,
  });

const closeWindow = () =>
  db
    .update(conversations)
    .set({ lastInboundAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })
    .where(eq(conversations.id, conversationId));

describe('reading conversations', () => {
  it('lists the conversation with the client behind it', async () => {
    await seedMessage({ body: 'Бағасы қанша?' });

    const res = await list();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
    expect(res.json()[0]).toMatchObject({
      id: conversationId,
      contactName: 'Айгерім',
      contactPhone: '77771234567',
      preview: 'Бағасы қанша?',
      windowOpen: true,
      adHeadline: null,
    });
  });

  it('puts the most recently active conversation first', async () => {
    const [older] = await db
      .insert(contacts)
      .values({ agentId, phone: '77009990000', name: 'Старый' })
      .returning();
    await db.insert(conversations).values({
      agentId,
      contactId: older!.id,
      whatsappNumberId: numberId,
      lastInboundAt: new Date(Date.now() - 3 * DAY),
      lastMessageAt: new Date(Date.now() - 3 * DAY),
    });

    expect((await list()).json().map((c: { contactName: string }) => c.contactName)).toEqual([
      'Айгерім',
      'Старый',
    ]);
  });

  it('says the window is closed a day after the last inbound message', async () => {
    await closeWindow();

    expect((await list()).json()[0].windowOpen).toBe(false);
  });

  it('shows the ad a conversation came from', async () => {
    await db
      .update(conversations)
      .set({ adHeadline: 'Картина-светильник 2 в 1', ctwaClid: 'ARAa', referralSeenAt: new Date() })
      .where(eq(conversations.id, conversationId));

    expect((await list()).json()[0].adHeadline).toBe('Картина-светильник 2 в 1');
  });

  it('returns a thread in the order the messages were sent', async () => {
    await seedMessage({ body: 'первое', sentAt: new Date(Date.now() - 2000) });
    await seedMessage({ body: 'второе', sentAt: new Date(Date.now() - 1000) });

    const res = await thread();

    expect(res.json().messages.map((m: { body: string }) => m.body)).toEqual([
      'первое',
      'второе',
    ]);
  });

  it('never puts a path on our disk in the answer', async () => {
    await seedMessage({ kind: 'image', body: null, mediaPath: `${agentId}/x.jpg`, mediaMime: 'image/jpeg' });

    const [message] = (await thread()).json().messages;

    expect(message.hasMedia).toBe(true);
    expect(message.mediaMime).toBe('image/jpeg');
    expect(JSON.stringify(message)).not.toContain('.jpg');
  });

  it('lets a member read a thread', async () => {
    await db
      .update(accountMembers)
      .set({ role: 'member' })
      .where(eq(accountMembers.accountId, accountId));

    expect((await thread()).statusCode).toBe(200);
  });

  it('hides another agent conversation behind a 404', async () => {
    const stranger = await createAccountWithOwner(db, {
      company: 'Чужая',
      email: 'stranger@example.com',
      name: 'Чужой',
      initials: 'ЧУ',
      password: PASSWORD,
    });
    const [foreignAgent] = await db
      .insert(agents)
      .values({ accountId: stranger.accountId, name: 'Чужой' })
      .returning();
    const [foreignContact] = await db
      .insert(contacts)
      .values({ agentId: foreignAgent!.id, phone: '77000000000' })
      .returning();
    const [foreignNumber] = await db
      .insert(whatsappNumbers)
      .values({
        agentId: foreignAgent!.id,
        phoneNumberId: '999',
        wabaId: '999',
        displayPhone: '+7 700 000 00 00',
        accessToken: encryptSecret('other', key),
      })
      .returning();
    const [foreign] = await db
      .insert(conversations)
      .values({
        agentId: foreignAgent!.id,
        contactId: foreignContact!.id,
        whatsappNumberId: foreignNumber!.id,
      })
      .returning();

    const res = await thread(foreign!.id);

    expect(res.statusCode).toBe(404);
    expect(res.json().message).toBe('Диалог не найден');
  });
});

describe('answering', () => {
  it('sends through Meta and stores what was sent', async () => {
    const res = await answer({ body: 'Здравствуйте! Сейчас подберём.' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      direction: 'out',
      author: 'operator',
      kind: 'text',
      body: 'Здравствуйте! Сейчас подберём.',
      status: 'sent',
    });

    expect(graph.calls[0]!.method).toBe('sendText');
    expect(graph.calls[0]!.args.slice(0, 4)).toEqual([
      '136',
      'EAAG-token',
      '77771234567',
      'Здравствуйте! Сейчас подберём.',
    ]);
  });

  it('stores the id Meta returned, so a status callback can find the row', async () => {
    await withGraph(fakeGraph({ sendText: async () => ({ messageId: 'wamid.FROM_META' }) }));

    await answer({ body: 'привет' });

    const [stored] = await db.select().from(messages);
    expect(stored!.waMessageId).toBe('wamid.FROM_META');
  });

  it('moves the conversation to the top of the list', async () => {
    const before = (await db.select().from(conversations))[0]!.lastMessageAt!;

    await answer({ body: 'привет' });

    const after = (await db.select().from(conversations))[0]!.lastMessageAt!;
    expect(after.getTime()).toBeGreaterThanOrEqual(before.getTime());
  });

  it('refuses an empty message', async () => {
    const res = await answer({ body: '   ' });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('Сообщение не может быть пустым');
    expect(await db.select().from(messages)).toEqual([]);
  });

  it('refuses to write outside the window, without asking Meta', async () => {
    await closeWindow();

    const res = await answer({ body: 'ещё актуально?' });

    expect(res.statusCode).toBe(409);
    expect(res.json().message).toBe(
      'Окно ответа закрыто. Клиент должен написать первым, либо нужен шаблон.',
    );
    expect(graph.calls).toEqual([]);
    expect(await db.select().from(messages)).toEqual([]);
  });

  it('refuses to answer through a disabled number', async () => {
    await db
      .update(whatsappNumbers)
      .set({ enabled: false })
      .where(eq(whatsappNumbers.id, numberId));

    const res = await answer({ body: 'привет' });

    expect(res.statusCode).toBe(409);
    expect(res.json().message).toBe('Номер отключён. Включите его в интеграциях.');
  });

  it('does not store a message Meta refused', async () => {
    await withGraph(
      fakeGraph({
        sendText: async () => {
          throw new GraphError('Recipient phone number not in allowed list', 400, 131030);
        },
      }),
    );

    const res = await answer({ body: 'привет' });

    expect(res.statusCode).toBe(502);
    expect(res.json().message).toBe(
      'Meta не отправила сообщение: Recipient phone number not in allowed list',
    );
    expect(await db.select().from(messages)).toEqual([]);
  });
});

describe('media', () => {
  const writeMedia = async (relative: string, bytes: Buffer) => {
    const absolute = join(env.MEDIA_DIR, relative);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, bytes);
  };

  it('streams a stored file with its own type', async () => {
    const message = await seedMessage({
      kind: 'image',
      body: null,
      mediaPath: `${agentId}/photo.jpg`,
      mediaMime: 'image/jpeg',
    });
    await writeMedia(`${agentId}/photo.jpg`, Buffer.from([9, 8, 7]));

    const res = await app.inject({
      method: 'GET',
      url: `/api/agents/${agentId}/messages/${message.id}/media`,
      cookies: jar,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('image/jpeg');
    expect([...res.rawPayload]).toEqual([9, 8, 7]);
  });

  it('answers 404 for a message that carries no file', async () => {
    const message = await seedMessage();

    const res = await app.inject({
      method: 'GET',
      url: `/api/agents/${agentId}/messages/${message.id}/media`,
      cookies: jar,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().message).toBe('Файл не найден');
  });

  it('answers 404 when the file is recorded but missing from disk', async () => {
    const message = await seedMessage({
      kind: 'image',
      mediaPath: `${agentId}/gone.jpg`,
      mediaMime: 'image/jpeg',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/agents/${agentId}/messages/${message.id}/media`,
      cookies: jar,
    });

    expect(res.statusCode).toBe(404);
  });
});
```
