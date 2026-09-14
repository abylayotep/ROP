/**
 * The agent answering a real message, and the routes the cabinet drives it with.
 *
 * Two halves, one fixture. The queue half stores a delivery and runs the queue exactly as
 * the webhook route does, so what is under test is the wiring between a stored message and a
 * turn. The route half drives the settings, the model list, the sandbox and the
 * per-conversation switch through HTTP.
 *
 * Nothing here reaches the network: the model and the Graph client are both fakes.
 */
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SANDBOX_TURNS, sandboxTurns } from '../src/api/ai.js';
import { buildServer } from '../src/api/server.js';
import type { Db } from '../src/db/client.js';
import {
  agentRules,
  agents,
  aiReplies,
  contacts,
  conversations,
  kbChunks,
  leadFields,
  leadValues,
  messages,
  notes,
  stages,
  whatsappEvents,
  whatsappNumbers,
} from '../src/db/schema.js';
import { ModelError, type Completion, type ModelClient } from '../src/lib/ai/openrouter.js';
import { keyAad } from '../src/lib/ai/turn.js';
import { seedFunnel } from '../src/lib/funnel.js';
import { saveNote } from '../src/lib/knowledge/notes.js';
import { addMember, createAccountWithOwner } from '../src/lib/provision.js';
import { decryptSecret, encryptSecret } from '../src/lib/secret-box.js';
import { processPendingEvents, type InboundDeps } from '../src/lib/whatsapp/inbound.js';
import { withDb } from './helpers/db.js';
import { testEnv } from './helpers/env.js';
import { fakeGraph, type FakeGraph } from './helpers/fake-graph.js';
import { fakeModel, type FakeModel } from './helpers/fake-model.js';
import { fakeLinked } from './helpers/fake-linked.js';

/** No test opens a socket: a linked number never appears in these fixtures. */
const linked = fakeLinked();

const env = testEnv();
const key = Buffer.from(env.CREDENTIALS_KEY, 'base64');
const PASSWORD = 'correct-horse-battery';

/** The OpenRouter key this agent holds. No test may let it out of the process. */
const OPENROUTER_KEY = 'sk-or-v1-0123456789abcdef';
const WHATSAPP_TOKEN = 'EAAG-token';

let db: Db;
let app: FastifyInstance;
let graph: FakeGraph;
/** Reassigned per test; the server and the queue both answer through whatever it holds. */
let model: FakeModel;
let agentId: string;
let itemId: string;
let cityFieldId: string;
let jar: Record<string, string>;

/** The five keys a model is asked for, with only the ones a test cares about overridden. */
function answer(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    reply: 'Здравствуйте! Чем помочь?',
    stageId: null,
    fields: {},
    handoff: null,
    usedItemIds: [],
    ...over,
  });
}

/**
 * A model whose answer is fine and whose bill will not fit the column.
 *
 * The only way to make a turn raise after it has already spent everything: `numeric(12,8)`
 * holds four digits before the point, so the reply log's insert fails on a cost of a
 * trillion dollars — after the reply has reached the customer. It is the shape of failure
 * the queue has to survive, and no assertion about it is worth much if the failure is faked
 * one step earlier.
 */
function ruinousModel(): FakeModel {
  const calls: FakeModel['calls'] = [];
  return {
    calls,
    async complete(input): Promise<Completion> {
      calls.push(input);
      return {
        text: answer({ reply: 'Доставка 1500 ₸.', usedItemIds: [itemId] }),
        promptTokens: 100,
        completionTokens: 20,
        cost: '999999999999',
      };
    },
  };
}

const deps = (): InboundDeps => ({ graph, linked, key, mediaDir: env.MEDIA_DIR, model });

/** Seconds, the way Meta counts them, and recent enough to leave the 24-hour window open. */
const secondsAgo = (seconds: number) => String(Math.floor(Date.now() / 1000) - seconds);

interface Line {
  id: string;
  body: string;
  ago: number;
  /** Whose line it is. One delivery can carry several customers. */
  from?: string;
  /** An image instead of text, which is what makes the media download run. */
  mediaId?: string;
}

/** One delivery, in the shape Meta actually sends, carrying whatever lines are given. */
const delivery = (lines: Line[]) => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: '932',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '77085807932', phone_number_id: '136' },
            contacts: [...new Set(lines.map((line) => line.from ?? '77771234567'))].map(
              (waId) => ({ profile: { name: `Клиент ${waId.slice(-4)}` }, wa_id: waId }),
            ),
            messages: lines.map((line) => ({
              from: line.from ?? '77771234567',
              id: line.id,
              timestamp: secondsAgo(line.ago),
              ...(line.mediaId
                ? {
                    type: 'image',
                    image: { id: line.mediaId, mime_type: 'image/jpeg', caption: line.body },
                  }
                : { type: 'text', text: { body: line.body } }),
            })),
          },
        },
      ],
    },
  ],
});

const asks = (body = 'Сколько стоит доставка?') =>
  delivery([{ id: `wamid.${randomUUID()}`, body, ago: 5 }]);

const store = (payload: unknown) => db.insert(whatsappEvents).values({ payload });

const sends = () => graph.calls.filter((call) => call.method === 'sendText');

const outbound = async () =>
  (await db.select().from(messages).orderBy(asc(messages.sentAt))).filter(
    (row) => row.direction === 'out',
  );

/**
 * A conversation under a different account, with its own agent, number and contact.
 *
 * Everything about it is real except that this test's owner has no business with it, which
 * is the only way to see whether a route's tenancy condition is load-bearing.
 */
async function otherAccountConversation(): Promise<string> {
  const { accountId } = await createAccountWithOwner(db, {
    company: 'Другая компания',
    email: 'stranger@example.com',
    name: 'Чужой',
    initials: 'ЧУ',
    password: PASSWORD,
  });
  const [agent] = await db.insert(agents).values({ accountId, name: 'Чужой агент' }).returning();
  const [number] = await db
    .insert(whatsappNumbers)
    .values({
      agentId: agent!.id,
      phoneNumberId: '999',
      wabaId: '999',
      displayPhone: '+7 700 000 00 00',
      accessToken: encryptSecret(WHATSAPP_TOKEN, key, '999'),
    })
    .returning();
  const [contact] = await db
    .insert(contacts)
    .values({ agentId: agent!.id, phone: '77009998877' })
    .returning();
  const [conversation] = await db
    .insert(conversations)
    .values({
      agentId: agent!.id,
      contactId: contact!.id,
      whatsappNumberId: number!.id,
    })
    .returning();
  return conversation!.id;
}

async function login(email = 'owner@example.com') {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: PASSWORD },
  });
  const cookie = res.cookies[0]!;
  return { [cookie.name]: cookie.value };
}

const settingsUrl = () => `/api/agents/${agentId}/ai`;

const patchSettings = (payload: Record<string, unknown>, cookies = jar) =>
  app.inject({ method: 'PATCH', url: settingsUrl(), cookies, payload });

const sandbox = (payload: Record<string, unknown>, cookies = jar) =>
  app.inject({
    method: 'POST',
    url: `/api/agents/${agentId}/ai/sandbox`,
    cookies,
    payload,
  });

/** Every kind of row the sandbox could leave behind, counted. */
async function census() {
  return {
    contacts: (await db.select().from(contacts)).length,
    conversations: (await db.select().from(conversations)).length,
    messages: (await db.select().from(messages)).length,
    replies: (await db.select().from(aiReplies)).length,
    notes: (await db.select().from(notes)).length,
    leadValues: (await db.select().from(leadValues)).length,
  };
}

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

  // Minted here rather than read back, because the OpenRouter key is sealed against it and
  // the row carries the sealed value from the start.
  agentId = randomUUID();
  await db.insert(agents).values({
    id: agentId,
    accountId,
    name: 'Сафина',
    aiEnabled: true,
    responseMode: 'live',
    openrouterKey: encryptSecret(OPENROUTER_KEY, key, keyAad(agentId)),
  });
  // Replaces the old `instructions: 'Продавай двери. Будь краток.'` column value: one rule
  // per sentence, which is what the owner would actually have typed as two rules.
  await db.insert(agentRules).values([
    { agentId, category: 'business', text: 'Продавай двери.', position: 0 },
    { agentId, category: 'tone', text: 'Будь краток.', position: 0 },
  ]);
  await seedFunnel(db, agentId);

  const [field] = await db
    .insert(leadFields)
    .values({ agentId, name: 'Город', kind: 'text', hint: 'Откуда клиент', position: 0 })
    .returning();
  cityFieldId = field!.id;

  // One note, one lead section with no heading: the chunk it produces carries the note's own
  // title, so the fixture reads exactly as the flat `kbItems` row it replaces did.
  const note = await saveNote(db, {
    agentId,
    path: 'Доставка',
    body: '---\nkind: product\n---\nДоставка по Алматы — 1500 ₸, от 20 000 ₸ бесплатно.',
  });
  const [chunk] = await db.select().from(kbChunks).where(eq(kbChunks.noteId, note.id));
  itemId = chunk!.id;

  await db.insert(whatsappNumbers).values({
    agentId,
    phoneNumberId: '136',
    wabaId: '932',
    displayPhone: '+7 708 580 79 32',
    accessToken: encryptSecret(WHATSAPP_TOKEN, key, '136'),
  });

  graph = fakeGraph();
  model = fakeModel(answer({ reply: 'Доставка 1500 ₸.', usedItemIds: [itemId] }));
  // A stable client that reads `model` at call time, so a test can script its own answer
  // after the server has already been built.
  const client: ModelClient = { complete: (input) => model.complete(input) };
  app = buildServer(env, db, { graph, model: client });
  await app.ready();
  jar = await login();
});

afterEach(async () => {
  await app.close();
  await rm(env.MEDIA_DIR, { recursive: true, force: true });
});

describe('answering an inbound message', () => {
  it('replies to the customer and stores the reply as the agent’s', async () => {
    await store(asks());

    expect(await processPendingEvents(db, deps())).toEqual({ processed: 1, failed: 0 });

    expect(sends()).toHaveLength(1);
    expect(sends()[0]!.args).toEqual(['136', WHATSAPP_TOKEN, '77771234567', 'Доставка 1500 ₸.']);

    const [reply] = await outbound();
    expect(reply).toMatchObject({
      direction: 'out',
      author: 'ai',
      kind: 'text',
      body: 'Доставка 1500 ₸.',
      status: 'sent',
    });

    const [logged] = await db.select().from(aiReplies);
    expect(logged).toMatchObject({ agentId, outcome: 'sent', usedItemIds: [itemId] });
    expect(logged!.messageId).toBe(reply!.id);
  });

  it('answers three lines of one delivery once, and answers the last of them', async () => {
    await store(
      delivery([
        { id: 'wamid.A', body: 'Здравствуйте', ago: 7 },
        { id: 'wamid.B', body: 'Хочу дверь', ago: 6 },
        { id: 'wamid.C', body: 'Сколько стоит доставка?', ago: 5 },
      ]),
    );

    await processPendingEvents(db, deps());

    expect(model.calls).toHaveLength(1);
    expect(sends()).toHaveLength(1);
    expect(await outbound()).toHaveLength(1);

    // All three are in the prompt, and the last one is the message the turn is answering.
    const prompt = (model.calls[0]?.messages ?? []).map((m) => m.content).join('\n');
    expect(prompt).toContain('Здравствуйте');
    expect(prompt).toContain('Хочу дверь');
    expect(prompt).toContain('Сколько стоит доставка?');
  });

  it('says nothing when the agent is switched off', async () => {
    await db.update(agents).set({ aiEnabled: false }).where(eq(agents.id, agentId));
    await store(asks());

    expect(await processPendingEvents(db, deps())).toEqual({ processed: 1, failed: 0 });

    expect(model.calls).toHaveLength(0);
    expect(sends()).toHaveLength(0);
    expect(await outbound()).toHaveLength(0);
    // The inbound message is stored all the same: the switch is about answering, not about
    // whether the business hears its customers.
    expect(await db.select().from(messages)).toHaveLength(1);
  });

  it('stores a Cloud message for a denied test contact without starting automation', async () => {
    const [selected] = await db
      .insert(contacts)
      .values({ agentId, phone: '77770000000', name: 'Тестовый клиент' })
      .returning();
    await db
      .update(agents)
      .set({ responseMode: 'test', testContactId: selected!.id })
      .where(eq(agents.id, agentId));
    const [stage] = await db.select().from(stages).where(eq(stages.agentId, agentId)).limit(1);
    model = fakeModel(
      answer({
        stageId: stage!.id,
        fields: { [cityFieldId]: 'Алматы' },
        handoff: { reason: 'клиент просит человека' },
      }),
    );
    let crmCalls = 0;
    const deniedDeps: InboundDeps = {
      ...deps(),
      crm: async () => {
        crmCalls += 1;
        return false;
      },
    };
    await store(asks());

    expect(await processPendingEvents(db, deniedDeps)).toEqual({ processed: 1, failed: 0 });

    expect(await db.select().from(messages)).toHaveLength(1);
    expect(model.calls).toHaveLength(0);
    expect(crmCalls).toBe(0);
    expect(await db.select().from(leadValues)).toHaveLength(0);
    expect(await db.select().from(notes)).toHaveLength(0);
    expect(await db.select().from(aiReplies)).toHaveLength(0);
    expect(sends()).toHaveLength(0);
  });

  it('says nothing on a conversation an operator has taken over', async () => {
    await store(asks());
    await processPendingEvents(db, deps());
    expect(sends()).toHaveLength(1);

    await db.update(conversations).set({ aiEnabled: false });
    await store(asks('А в Астану возите?'));

    expect(await processPendingEvents(db, deps())).toEqual({ processed: 1, failed: 0 });
    expect(sends()).toHaveLength(1);
  });

  it('answers each of two customers in one delivery once', async () => {
    await store(
      delivery([
        { id: 'wamid.A1', body: 'Здравствуйте!', ago: 6, from: '77771234567' },
        { id: 'wamid.B1', body: 'Сколько стоит доставка?', ago: 5, from: '77770000009' },
        { id: 'wamid.A2', body: 'Сколько стоит доставка?', ago: 4, from: '77771234567' },
      ]),
    );

    await processPendingEvents(db, deps());

    // Two conversations, two turns, two replies — the rule is one answer per customer, not
    // one answer per delivery.
    expect(await db.select().from(conversations)).toHaveLength(2);
    expect(model.calls).toHaveLength(2);
    expect(sends()).toHaveLength(2);
    expect([...new Set(sends().map((call) => call.args[2]))].sort()).toEqual([
      '77770000009',
      '77771234567',
    ]);
  });

  it('does not answer a message another pass stored first', async () => {
    // The race the `known` read cannot see: two passes claim one event, both find the
    // message missing, and both go on to store it. Only the insert can say who won, and
    // whoever lost must not answer — the winner is already answering.
    //
    // Staged rather than hoped for: the media download sits between the read and the store
    // and goes through the Graph client, so the other pass's insert happens exactly there.
    graph = fakeGraph({
      getMediaUrl: async () => {
        const [conversation] = await db.select().from(conversations);
        await db.insert(messages).values({
          conversationId: conversation!.id,
          waMessageId: 'wamid.RACE',
          direction: 'in',
          author: 'client',
          kind: 'image',
          body: 'Сколько стоит доставка?',
          sentAt: new Date(),
        });
        return { url: 'https://lookaside.fb/media', mimeType: 'image/jpeg', fileSize: 3 };
      },
    });
    await store(
      delivery([
        { id: 'wamid.RACE', body: 'Сколько стоит доставка?', ago: 5, mediaId: 'media-1' },
      ]),
    );

    expect(await processPendingEvents(db, deps())).toEqual({ processed: 1, failed: 0 });

    expect(await db.select().from(messages)).toHaveLength(1);
    expect(model.calls).toHaveLength(0);
    expect(sends()).toHaveLength(0);
  });

  it('does not answer a message Meta delivered twice', async () => {
    const twice = delivery([{ id: 'wamid.ONCE', body: 'Сколько стоит доставка?', ago: 5 }]);
    await store(twice);
    await store(twice);

    expect(await processPendingEvents(db, deps())).toEqual({ processed: 2, failed: 0 });

    expect(model.calls).toHaveLength(1);
    expect(sends()).toHaveLength(1);
  });

  it('leaves the event processed and hands off with a holding line when the model refuses', async () => {
    model = fakeModel(new ModelError('OpenRouter не принял ключ.', 401, 'invalid api key'));
    await store(asks());

    expect(await processPendingEvents(db, deps())).toEqual({ processed: 1, failed: 0 });

    const [event] = await db.select().from(whatsappEvents);
    expect(event!.processedAt).not.toBeNull();
    // The customer is not left to silence: one holding line, and a person owns the thread.
    expect(await db.select().from(messages)).toHaveLength(2);
    expect(sends().map((call) => call.args[3])).toEqual(['Секунду, уточню у коллеги и сразу вернусь с ответом.']);

    const [logged] = await db.select().from(aiReplies);
    expect(logged).toMatchObject({ outcome: 'handoff' });
    expect(logged!.detail).toContain('OpenRouter не принял ключ.');
  });

  it('leaves the event processed when the turn itself raises', async () => {
    model = ruinousModel();
    await store(asks());

    expect(await processPendingEvents(db, deps())).toEqual({ processed: 1, failed: 0 });

    const [event] = await db.select().from(whatsappEvents);
    // Processed, so no later pass claims it again — a second turn would send the customer
    // the same sentence twice, and the reply below has already reached them.
    expect(event!.processedAt).not.toBeNull();
    expect(event!.error).toContain('ответ агента не удался');
    expect(sends()).toHaveLength(1);

    expect(await processPendingEvents(db, deps())).toEqual({ processed: 0, failed: 0 });
    expect(sends()).toHaveLength(1);
  });

  it('is processed before the turn runs, so a pass in that window cannot claim it', async () => {
    // The turns used to run inside `applyPayload`, before `processed_at` was written, so the
    // event stayed claimable for the whole turn — up to two model deadlines. Every webhook
    // arriving in that window started a pass that claimed it again and burned an attempt;
    // five of those and a restart retired the event with the customer's message unanswered.
    let reentered = false;
    let inFlight: { processed: number; failed: number } | null = null;
    const calls: FakeModel['calls'] = [];
    model = {
      calls,
      async complete(input): Promise<Completion> {
        calls.push(input);
        // A second webhook lands while the model is thinking, and its route runs a pass.
        if (!reentered) {
          reentered = true;
          inFlight = await processPendingEvents(db, deps());
        }
        return {
          text: answer(),
          promptTokens: 100,
          completionTokens: 20,
          cost: '0.00010000',
        };
      },
    };
    await store(asks());

    expect(await processPendingEvents(db, deps())).toEqual({ processed: 1, failed: 0 });

    // The pass that ran mid-turn found nothing to take, and the event kept its one attempt.
    expect(inFlight).toEqual({ processed: 0, failed: 0 });
    const [event] = await db.select().from(whatsappEvents);
    expect(event!.attempts).toBe(1);
    expect(model.calls).toHaveLength(1);
    expect(sends()).toHaveLength(1);
  });
});

describe('the settings routes', () => {
  it('answers what is set and whether there is a key, never the key', async () => {
    const res = await app.inject({ method: 'GET', url: settingsUrl(), cookies: jar });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      aiEnabled: true,
      responseMode: 'live',
      crmAnalysisMode: 'follow_ai',
      testContact: null,
      model: 'openai/gpt-4o-mini',
      temperature: 0.3,
      replyLanguage: 'auto',
      keySet: true,
    });
    expect(res.body).not.toContain(OPENROUTER_KEY);
    expect(res.body).not.toContain('openrouterKey');
  });

  it('lets a member read the settings and an owner change them', async () => {
    const asMember = await login('member@example.com');

    const read = await app.inject({ method: 'GET', url: settingsUrl(), cookies: asMember });
    expect(read.statusCode).toBe(200);

    expect((await patchSettings({ aiEnabled: false }, asMember)).statusCode).toBe(403);
  });

  it('stores the key sealed against the agent and answers without it', async () => {
    await db.update(agents).set({ openrouterKey: null }).where(eq(agents.id, agentId));

    const res = await patchSettings({ openrouterKey: 'sk-or-v1-new', aiEnabled: false });

    expect(res.statusCode).toBe(200);
    expect(res.json().keySet).toBe(true);
    expect(res.body).not.toContain('sk-or-v1-new');

    const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(row!.openrouterKey).not.toBeNull();
    expect(row!.openrouterKey).not.toContain('sk-or-v1-new');
    // Sealed with the same associated data the turn opens it with, or it would encrypt
    // perfectly and never decrypt.
    expect(decryptSecret(row!.openrouterKey!, key, keyAad(agentId))).toBe('sk-or-v1-new');
  });

  it('clears the key on an explicit null', async () => {
    const res = await patchSettings({ openrouterKey: null, aiEnabled: false });

    expect(res.json().keySet).toBe(false);
    const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(row!.openrouterKey).toBeNull();
  });

  it('changes the model, the temperature and the language', async () => {
    const res = await patchSettings({
      model: 'anthropic/claude-sonnet-4.5',
      temperature: 0.75,
      replyLanguage: 'Русский',
    });

    expect(res.json()).toMatchObject({
      model: 'anthropic/claude-sonnet-4.5',
      temperature: 0.75,
      replyLanguage: 'Русский',
    });
  });

  it('refuses a model that is not on the list', async () => {
    const res = await patchSettings({ model: 'openai/gpt-9' });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('Неизвестная модель');
    const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(row!.model).toBe('openai/gpt-4o-mini');
  });

  it('says which way to fix it when the key is cleared on a live agent', async () => {
    const res = await patchSettings({ openrouterKey: null });

    expect(res.statusCode).toBe(400);
    // Not «добавьте ключ»: the owner just asked to remove it, and being told to put it back
    // answers the opposite of what they asked.
    expect(res.json().message).toBe('Сначала выключите агента: без ключа он не сможет отвечать');
    const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(row!.openrouterKey).not.toBeNull();
  });

  it('refuses to switch the agent on while it has no key', async () => {
    await db.update(agents).set({ aiEnabled: false, openrouterKey: null });

    const res = await patchSettings({ aiEnabled: true });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('Сначала добавьте ключ OpenRouter');
  });

  it('answers the model list to anyone signed in, and to nobody else', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/ai/models', cookies: jar });

    expect(res.statusCode).toBe(200);
    expect(res.json()[0]).toMatchObject({ id: 'openai/gpt-4o-mini', label: 'GPT-4o mini' });
    expect(res.json().every((m: { description: string }) => m.description.length > 0)).toBe(true);

    expect((await app.inject({ method: 'GET', url: '/api/ai/models' })).statusCode).toBe(401);
  });
});

describe('the sandbox', () => {
  it('answers what the agent would do and writes nothing at all', async () => {
    const [stage] = await db
      .select()
      .from(stages)
      .where(eq(stages.agentId, agentId))
      .orderBy(asc(stages.position));
    model = fakeModel(
      answer({
        reply: 'Доставка 1500 ₸.',
        usedItemIds: [itemId],
        stageId: stage!.id,
        fields: { [cityFieldId]: 'Алматы' },
      }),
    );

    const before = await census();
    const res = await sandbox({ text: 'Сколько стоит доставка?' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      reply: 'Доставка 1500 ₸.',
      usedItems: [{ id: itemId, title: 'Доставка' }],
      stageName: stage!.name,
      fields: [{ id: cityFieldId, name: 'Город', value: 'Алматы' }],
      handoff: null,
      outcome: 'sent',
      detail: null,
    });

    // Nothing sent, and nothing left behind: not the conversation it needed, not a reply
    // log, not a stage move on anybody's lead.
    expect(sends()).toHaveLength(0);
    expect(await census()).toEqual(before);
    expect(await db.select().from(aiReplies)).toHaveLength(0);
  });

  it('runs with the agent switched off, which is when an owner needs it', async () => {
    await db.update(agents).set({ aiEnabled: false }).where(eq(agents.id, agentId));

    const res = await sandbox({ text: 'Сколько стоит доставка?' });

    expect(res.statusCode).toBe(200);
    expect(res.json().outcome).toBe('sent');
    expect(model.calls).toHaveLength(1);
  });

  it('reports a handoff rather than performing one', async () => {
    model = fakeModel(
      answer({ reply: 'Позову коллегу.', handoff: { reason: 'клиент просит человека' } }),
    );

    const res = await sandbox({ text: 'Позовите человека' });

    // The reply is still shown: an owner tuning instructions has to see what the agent
    // would have said before it stepped aside.
    expect(res.json()).toMatchObject({
      // The reason, not a flag: it is why an owner runs the sandbox at all.
      handoff: 'клиент просит человека',
      outcome: 'handoff',
      reply: 'Позову коллегу.',
    });
    // The conversation it ran on is gone, so there is nothing left switched off, and no
    // note about a handoff that did not happen.
    expect(await db.select().from(conversations)).toHaveLength(0);
    expect(await db.select().from(notes)).toHaveLength(0);
  });

  it('refuses without a number, rather than pretending a reply was delivered', async () => {
    await db.delete(whatsappNumbers).where(eq(whatsappNumbers.agentId, agentId));

    const res = await sandbox({ text: 'Сколько стоит доставка?' });

    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain('подключите номер');
  });

  it('refuses a fourth turn while three are thinking, and frees the slot after', async () => {
    // Every sandbox turn holds a connection for as long as the model takes. Three at once is
    // the cap; a fourth must be told to wait rather than join a queue for the pool that the
    // webhook is also waiting in.
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: FakeModel['calls'] = [];
    model = {
      calls,
      async complete(input) {
        calls.push(input);
        await held;
        return {
          text: answer({ reply: 'Доставка 1500 ₸.', usedItemIds: [itemId] }),
          promptTokens: 100,
          completionTokens: 20,
          cost: '0.00010000',
        };
      },
    };

    const running = [0, 1, 2].map(() => sandbox({ text: 'Сколько стоит доставка?' }));
    // Wait until all three are actually inside the model call, not merely dispatched.
    while (calls.length < 3) await new Promise((resolve) => setImmediate(resolve));

    const refused = await sandbox({ text: 'Сколько стоит доставка?' });
    expect(refused.statusCode).toBe(429);
    expect(refused.json().message).toBe('Песочница занята. Попробуйте через несколько секунд.');
    // Refused, not run: the fourth call never reached the model.
    expect(calls).toHaveLength(3);

    release();
    for (const res of await Promise.all(running)) expect(res.statusCode).toBe(200);

    // The slots came back, so the cap is a gauge and not a budget spent once.
    expect((await sandbox({ text: 'Сколько стоит доставка?' })).statusCode).toBe(200);
  });

  it('frees the slot when the turn raises', async () => {
    // A client that answers with nothing at all, which `runTurn` reads straight through and
    // raises on — the failure the `finally` exists for.
    model = {
      calls: [],
      complete: async () => undefined as unknown as Completion,
    };
    for (let attempt = 0; attempt < SANDBOX_TURNS + 1; attempt += 1) {
      expect((await sandbox({ text: 'Сколько стоит доставка?' })).statusCode).toBe(500);
    }

    model = fakeModel(answer({ reply: 'Доставка 1500 ₸.', usedItemIds: [itemId] }));
    expect((await sandbox({ text: 'Сколько стоит доставка?' })).statusCode).toBe(200);
  });

  it('is the owner’s, and needs something to answer', async () => {
    const asMember = await login('member@example.com');
    expect((await sandbox({ text: 'Привет' }, asMember)).statusCode).toBe(403);
    expect((await sandbox({ text: '   ' })).statusCode).toBe(400);
  });

  describe('the cap on turns in flight', () => {
    it('is three on a pool with room for three', () => {
      expect(sandboxTurns(10)).toBe(3);
      expect(SANDBOX_TURNS).toBe(3);
    });

    it('gives way to a pool too small for three', () => {
      expect(sandboxTurns(4)).toBe(2);
      expect(sandboxTurns(3)).toBe(1);
    });

    it('never reaches zero, which would answer 429 always', () => {
      // `Math.min(3, poolMax - 2)` alone is zero at a pool of two and negative below it, and
      // a cap of zero is not a small sandbox: it is one that refuses every owner, forever,
      // for a reason nothing on the screen explains.
      expect(sandboxTurns(2)).toBe(1);
      expect(sandboxTurns(1)).toBe(1);
      expect(sandboxTurns(0)).toBe(1);
    });
  });
});

describe('the per-conversation switch', () => {
  const switchUrl = (conversationId: string) =>
    `/api/agents/${agentId}/conversations/${conversationId}/ai`;

  const conversationId = async () => {
    const [row] = await db.select().from(conversations);
    return row!.id;
  };

  beforeEach(async () => {
    await store(asks());
    await processPendingEvents(db, deps());
  });

  it('lets any member stop the agent on one thread', async () => {
    const asMember = await login('member@example.com');
    const id = await conversationId();

    const res = await app.inject({
      method: 'PATCH',
      url: switchUrl(id),
      cookies: asMember,
      payload: { aiEnabled: false },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ aiEnabled: false });
    const [row] = await db.select().from(conversations).where(eq(conversations.id, id));
    expect(row!.aiEnabled).toBe(false);
  });

  it('switches it back on', async () => {
    const id = await conversationId();
    await db.update(conversations).set({ aiEnabled: false });

    const res = await app.inject({
      method: 'PATCH',
      url: switchUrl(id),
      cookies: jar,
      payload: { aiEnabled: true },
    });

    expect(res.json()).toEqual({ aiEnabled: true });
  });

  it('answers 404 for a conversation that exists under another account', async () => {
    // A real conversation belonging to somebody else, not a uuid belonging to nobody: an id
    // that matches no row is answered 404 by the absence of the row, and tests nothing about
    // the tenancy condition that is supposed to be doing the work.
    const stranger = await otherAccountConversation();

    const res = await app.inject({
      method: 'PATCH',
      url: switchUrl(stranger),
      cookies: jar,
      payload: { aiEnabled: false },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().message).toBe('Диалог не найден');
    const [row] = await db.select().from(conversations).where(eq(conversations.id, stranger));
    expect(row!.aiEnabled).toBe(true);
  });

  it('answers 404 for a conversation that is nobody’s', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: switchUrl(randomUUID()),
      cookies: jar,
      payload: { aiEnabled: false },
    });

    expect(res.statusCode).toBe(404);
    expect((await app.inject({
      method: 'PATCH',
      url: switchUrl('not-a-uuid'),
      cookies: jar,
      payload: { aiEnabled: false },
    })).statusCode).toBe(404);
  });
});
