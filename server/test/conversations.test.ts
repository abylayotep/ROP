import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import {
  accountMembers,
  agents,
  aiReplies,
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
import { fakeLinked } from './helpers/fake-linked.js';

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
      accessToken: encryptSecret('EAAG-token', key, '136'),
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

  // Built after the account exists: `withGraph` logs in, and there is nobody to log in
  // as until the owner above has been provisioned.
  await withGraph(fakeGraph());
});

afterEach(async () => {
  await rm(env.MEDIA_DIR, { recursive: true, force: true });
});

const list = () =>
  app.inject({ method: 'GET', url: `/api/agents/${agentId}/conversations`, cookies: jar });

const thread = (id = conversationId) =>
  app.inject({ method: 'GET', url: `/api/agents/${agentId}/conversations/${id}`, cookies: jar });

const answer = (body: Record<string, unknown>, id = conversationId) =>
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

  it('names the ai_replies row a message came from, and leaves the rest of the thread without one', async () => {
    const clientMessage = await seedMessage({ author: 'client', direction: 'in', body: 'дадите скидку?' });
    const aiMessage = await seedMessage({
      author: 'ai',
      direction: 'out',
      body: 'Доставка 1500 ₸.',
      sentAt: new Date(clientMessage.sentAt.getTime() + 1000),
    });
    const [reply] = await db
      .insert(aiReplies)
      .values({
        agentId,
        conversationId,
        messageId: aiMessage.id,
        model: 'test-model',
        outcome: 'sent',
      })
      .returning();

    const found = (await thread()).json().messages;

    expect(found.find((m: { id: string }) => m.id === clientMessage.id)!.aiReplyId).toBeNull();
    expect(found.find((m: { id: string }) => m.id === aiMessage.id)!.aiReplyId).toBe(reply!.id);
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
        accessToken: encryptSecret('other', key, '999'),
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

  it('answers outside the window through a phone connected by QR', async () => {
    // The 24-hour window is Meta's rule. A linked device is an ordinary WhatsApp client:
    // refusing here would refuse a send WhatsApp would have delivered.
    const linked = fakeLinked();
    linked.setOpen(numberId, true);
    app = buildServer(env, db, { graph, linked });
    await app.ready();
    jar = await login();
    await db
      .update(whatsappNumbers)
      .set({
        connectionKind: 'linked',
        phoneNumberId: null,
        wabaId: null,
        accessToken: null,
        linkedJid: '77085807932@s.whatsapp.net',
        linkedState: 'open',
      })
      .where(eq(whatsappNumbers.id, numberId));
    await closeWindow();

    const res = await answer({ body: 'ещё актуально?' });

    expect(res.statusCode).toBe(200);
    expect(linked.calls.at(-1)?.method).toBe('sendText');
    expect(graph.calls).toEqual([]);
  });

  it('refuses to answer through a phone that is not on the air', async () => {
    const linked = fakeLinked();
    app = buildServer(env, db, { graph, linked });
    await app.ready();
    jar = await login();
    await db
      .update(whatsappNumbers)
      .set({
        connectionKind: 'linked',
        phoneNumberId: null,
        wabaId: null,
        accessToken: null,
        linkedJid: '77085807932@s.whatsapp.net',
        linkedState: 'open',
      })
      .where(eq(whatsappNumbers.id, numberId));

    const res = await answer({ body: 'здравствуйте' });

    expect(res.statusCode).toBe(409);
    expect(res.json().message).toBe(
      'Телефон не на связи. Откройте WhatsApp на телефоне или подключите заново.',
    );
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

  it('does not echo the decrypted token back when Meta rejects the send', async () => {
    await withGraph(
      fakeGraph({
        sendText: async () => {
          throw new GraphError('Malformed access token EAAG-token', 401);
        },
      }),
    );

    const res = await answer({ body: 'привет' });

    expect(res.statusCode).toBe(502);
    expect(res.json().message).not.toContain('EAAG-token');
    expect(res.json().message).toContain('<токен скрыт>');
  });

  it('records that the token is dead when Meta refuses it, and says what to do', async () => {
    // The stored deadline is a prediction. Meta can invalidate a token early — the
    // business user loses access, the owner removes the application — and until this is
    // written down the cabinet keeps calling the number healthy while nothing sends.
    await db
      .update(whatsappNumbers)
      .set({ tokenExpiresAt: new Date(Date.now() + 30 * DAY) })
      .where(eq(whatsappNumbers.id, numberId));
    await withGraph(
      fakeGraph({
        sendText: async () => {
          throw new GraphError('Error validating access token: Session has expired', 401, 190);
        },
      }),
    );

    const res = await answer({ body: 'привет' });

    expect(res.statusCode).toBe(409);
    expect(res.json().message).toBe(
      'Доступ Meta к номеру истёк. Подключите номер заново в интеграциях.',
    );
    const [row] = await db.select().from(whatsappNumbers).where(eq(whatsappNumbers.id, numberId));
    // Within a minute of now rather than «not in the future»: the deadline is written by
    // Postgres' clock, and the test reads Node's. A month early is the point, not a second.
    expect(row!.tokenExpiresAt!.getTime()).toBeLessThan(Date.now() + 60_000);
    expect(row!.tokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(await db.select().from(messages)).toEqual([]);
  });

  it('leaves the deadline alone when Meta refuses for a reason re-connecting will not fix', async () => {
    const stated = new Date(Date.now() + 30 * DAY);
    await db
      .update(whatsappNumbers)
      .set({ tokenExpiresAt: stated })
      .where(eq(whatsappNumbers.id, numberId));
    await withGraph(
      fakeGraph({
        sendText: async () => {
          throw new GraphError('Recipient phone number not in allowed list', 400, 131030);
        },
      }),
    );

    await answer({ body: 'привет' });

    const [row] = await db.select().from(whatsappNumbers).where(eq(whatsappNumbers.id, numberId));
    expect(row!.tokenExpiresAt).toEqual(stated);
  });

  it('says in Russian that the number has to be reconnected when the token will not decrypt', async () => {
    // A rotated credentials key, or a row someone edited by hand. The crypto library's own
    // complaint is English and the frontend renders `message` verbatim.
    await db
      .update(whatsappNumbers)
      .set({ accessToken: 'not-a-packed-secret' })
      .where(eq(whatsappNumbers.id, numberId));

    const res = await answer({ body: 'привет' });

    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain('Подключите номер заново');
    expect(res.json().message).not.toMatch(/[A-Za-z]{4}/);
    expect(graph.calls.filter((call) => call.method === 'sendText')).toHaveLength(0);
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

  it('answers 404 for a message id that is not a uuid', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/agents/${agentId}/messages/not-a-uuid/media`,
      cookies: jar,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().message).toBe('Файл не найден');
  });
});
