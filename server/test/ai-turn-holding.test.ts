import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client.js';
import {
  agents,
  aiReplies,
  contacts,
  conversations,
  messages,
  notes,
  whatsappNumbers,
} from '../src/db/schema.js';
import {
  alreadyHolding,
  HOLDING_REPLIES,
  holdingLanguage,
  unseenSinceLastReply,
} from '../src/lib/ai/holding.js';
import { ModelError, type Completion, type CompletionInput } from '../src/lib/ai/openrouter.js';
import { runTurn } from '../src/lib/ai/turn.js';
import { createAccountWithOwner } from '../src/lib/provision.js';
import { encryptSecret } from '../src/lib/secret-box.js';
import { withDb } from './helpers/db.js';
import { testEnv } from './helpers/env.js';
import { fakeGraph, type FakeGraph } from './helpers/fake-graph.js';
import { fakeLinked } from './helpers/fake-linked.js';
import { fakeModel, type FakeModel } from './helpers/fake-model.js';

const env = testEnv();
const key = Buffer.from(env.CREDENTIALS_KEY, 'base64');
const OPERATOR = '77716944499';
const { ru: RU, kk: KK } = HOLDING_REPLIES;

let db: Db;
let graph: FakeGraph;
let agentId: string;
let conversationId: string;
/** Keeps every inserted message strictly after the one before it. */
let clock: number;

function answer(over: Record<string, unknown> = {}): string {
  return JSON.stringify({ reply: 'Здравствуйте!', stageId: null, fields: {}, handoff: null, usedItemIds: [], ...over });
}

/** A model that changes the world while it is thinking, then fails. */
function failingWhile(during: () => Promise<void>, error: Error): FakeModel {
  const calls: CompletionInput[] = [];
  return {
    calls,
    async complete(input): Promise<Completion> {
      calls.push(input);
      await during();
      throw error;
    },
  };
}

const turn = (model: FakeModel, options: { dryRun?: boolean } = {}) =>
  runTurn(db, { model, graph, linked: fakeLinked(), key }, { agentId, conversationId, ...options });

async function say(author: string, body: string | null, kind = 'text') {
  clock += 1000;
  await db.insert(messages).values({
    conversationId, direction: author === 'client' ? 'in' : 'out', author, kind, body,
    sentAt: new Date(clock),
  });
}

const customerSends = () => graph.calls
  .filter((call) => call.method === 'sendText' && call.args[2] !== OPERATOR)
  .map((call) => call.args[3]);
const operatorAlerts = () => graph.calls.filter((call) => call.method === 'sendText' && call.args[2] === OPERATOR);
const conversationRow = async () =>
  (await db.select().from(conversations).where(eq(conversations.id, conversationId)))[0]!;
const noteRows = () => db.select().from(notes).where(eq(notes.conversationId, conversationId));
const replyLog = () => db.select().from(aiReplies).where(eq(aiReplies.agentId, agentId));
const outbound = async () => (await db.select().from(messages)
  .where(eq(messages.conversationId, conversationId)).orderBy(asc(messages.sentAt)))
  .filter((message) => message.direction === 'out');

beforeEach(async () => {
  db = await withDb();
  graph = fakeGraph();
  clock = Date.now() - 10 * 60_000;
  const { accountId } = await createAccountWithOwner(db, {
    company: 'Печати', email: 'owner@holding.test', name: 'Владелец', initials: 'ВЛ', password: 'correct-horse-battery',
  });
  agentId = randomUUID();
  await db.insert(agents).values({
    id: agentId, accountId, name: 'Печати', aiEnabled: true, responseMode: 'live',
    operatorNotifyPhone: OPERATOR, openrouterKey: encryptSecret('sk-or-holding', key, agentId),
  });
  const [number] = await db.insert(whatsappNumbers).values({
    agentId, phoneNumberId: '136', wabaId: 'waba', displayPhone: '+7 708 580 79 32',
    accessToken: encryptSecret('EAAG-token', key, '136'),
  }).returning();
  const [contact] = await db.insert(contacts).values({ agentId, phone: '77085807932', name: 'Айгуль' }).returning();
  const [conversation] = await db.insert(conversations).values({
    agentId, contactId: contact!.id, whatsappNumberId: number!.id,
    lastInboundAt: new Date(Date.now() - 60_000), lastMessageAt: new Date(Date.now() - 60_000),
  }).returning();
  conversationId = conversation!.id;
});

describe('every ending without a sendable reply tells the customer someone is on it', () => {
  it('replaces a withheld number with one holding line and hands off', async () => {
    await say('client', 'Сколько стоит печать?');

    const result = await turn(fakeModel(answer({ reply: 'Печать стоит 7777 ₸.' })));

    expect(result.outcome).toBe('handoff');
    expect(customerSends()).toEqual([RU]);
    expect((await conversationRow()).aiEnabled).toBe(false);
    expect((await noteRows())[0]?.body).toContain('7777');
    expect(operatorAlerts()).toHaveLength(1);
  });

  it('answers a Kazakh customer in Kazakh when the model twice returns nothing readable', async () => {
    await say('client', 'Мөр қанша тұрады?');

    const result = await turn(fakeModel('не json', 'снова не json'));

    expect(result).toMatchObject({ outcome: 'handoff', reply: KK });
    expect(customerSends()).toEqual([KK]);
    expect(result.handoff).toContain('дважды');
  });

  it('hands off with the reason when OpenRouter has run out of money', async () => {
    await say('client', 'Здравствуйте, нужна печать');
    const model = fakeModel(new ModelError('На счёте OpenRouter закончились средства.', 402));

    const result = await turn(model);

    expect(result.outcome).toBe('handoff');
    expect(model.calls).toHaveLength(1);
    expect(customerSends()).toEqual([RU]);
    expect((await conversationRow()).aiEnabled).toBe(false);
    expect((await noteRows())[0]?.body).toContain('ИИ не смог ответить: На счёте OpenRouter закончились средства');
    const [log] = await replyLog();
    expect(log?.outcome).toBe('handoff');
    expect(log?.detail).toContain('закончились средства');
    const out = await outbound();
    expect(out.map((message) => message.body)).toEqual([RU]);
    expect(log?.messageId).toBe(out[0]?.id);
    expect(String(operatorAlerts()[0]?.args[3])).toContain('закончились средства');
  });

  it('hands off on a plain transport failure too', async () => {
    await say('client', 'Сәлеметсіз бе, мөр керек');

    const result = await turn(fakeModel(new Error('fetch failed')));

    expect(result).toMatchObject({ outcome: 'handoff', reply: KK });
    expect(customerSends()).toEqual([KK]);
    expect(result.handoff).toContain('fetch failed');
  });

  it('follows the language the owner chose over the customer’s', async () => {
    await db.update(agents).set({ replyLanguage: 'Қазақша' }).where(eq(agents.id, agentId));
    await say('client', 'Сколько стоит печать?');

    await turn(fakeModel(new Error('fetch failed')));

    expect(customerSends()).toEqual([KK]);
  });

  it('keeps sending the model’s own reply when it asked for a handoff with nothing withheld', async () => {
    await say('client', 'Позовите человека');

    const result = await turn(fakeModel(answer({ reply: 'Сейчас позову коллегу.', handoff: { reason: 'просит человека' } })));

    expect(result.outcome).toBe('handoff');
    expect(customerSends()).toEqual(['Сейчас позову коллегу.']);
  });

  it('shows the holding line in a dry run without sending or writing anything', async () => {
    await say('client', 'Сколько стоит печать?');

    const result = await turn(fakeModel(answer({ reply: 'Печать стоит 7777 ₸.' })), { dryRun: true });

    expect(result).toMatchObject({ outcome: 'handoff', reply: RU });
    expect(graph.calls).toHaveLength(0);
    expect(await replyLog()).toHaveLength(0);
    expect((await conversationRow()).aiEnabled).toBe(true);
  });

  it('keeps a failed model call failed in a dry run, so a draft check never counts it as answered', async () => {
    await say('client', 'Сколько стоит печать?');

    const result = await turn(fakeModel(new Error('fetch failed')), { dryRun: true });

    expect(result).toMatchObject({ outcome: 'failed', reply: null });
    expect(graph.calls).toHaveLength(0);
  });
});

describe('the holding line goes out only where a reply could have', () => {
  it('says nothing when the agent is switched off', async () => {
    await say('client', 'Сколько стоит печать?');
    await db.update(agents).set({ responseMode: 'off' }).where(eq(agents.id, agentId));
    const model = fakeModel(new Error('fetch failed'));

    expect((await turn(model)).outcome).toBe('skipped');
    expect(model.calls).toHaveLength(0);
    expect(graph.calls).toHaveLength(0);
  });

  it('says nothing when the window is closed', async () => {
    await say('client', 'Сколько стоит печать?');
    await db.update(conversations).set({ lastInboundAt: new Date(Date.now() - 2 * 86_400_000) })
      .where(eq(conversations.id, conversationId));

    expect((await turn(fakeModel(new Error('fetch failed')))).outcome).toBe('skipped');
    expect(graph.calls).toHaveLength(0);
  });

  it('says nothing and hands nothing off when an operator writes while the model fails', async () => {
    await say('client', 'Сколько стоит печать?');
    const model = failingWhile(() => say('operator', 'Здравствуйте, 5000 ₸.'), new Error('fetch failed'));

    const result = await turn(model);

    expect(result.outcome).toBe('failed');
    expect(graph.calls).toHaveLength(0);
    expect((await conversationRow()).aiEnabled).toBe(true);
    expect(await noteRows()).toHaveLength(0);
    expect((await replyLog())[0]?.outcome).toBe('failed');
  });

  it('says nothing when the agent is switched off while the model fails', async () => {
    await say('client', 'Сколько стоит печать?');
    const model = failingWhile(async () => {
      await db.update(agents).set({ responseMode: 'off' }).where(eq(agents.id, agentId));
    }, new Error('fetch failed'));

    const result = await turn(model);

    expect(['failed', 'skipped']).toContain(result.outcome);
    expect(graph.calls).toHaveLength(0);
    expect((await conversationRow()).aiEnabled).toBe(true);
  });

  it('says nothing when an operator has just written', async () => {
    await say('client', 'Сколько стоит печать?');
    await say('operator', 'Сейчас посчитаю.');

    expect((await turn(fakeModel(new Error('fetch failed')))).outcome).toBe('skipped');
    expect(graph.calls).toHaveLength(0);
  });

  it('holds again for a customer who wrote after an earlier holding line', async () => {
    await say('client', 'Сколько стоит печать?');
    await say('ai', RU);
    await say('client', 'Ну что?');

    await turn(fakeModel(new Error('fetch failed')));

    expect(customerSends()).toEqual([RU]);
  });
});

describe('attachments the agent cannot see', () => {
  it('hands off a lone photo without calling the model', async () => {
    await say('client', null, 'image');
    const model = fakeModel(answer());

    const result = await turn(model);

    expect(model.calls).toHaveLength(0);
    expect(result).toMatchObject({ outcome: 'handoff', reply: RU });
    expect(customerSends()).toEqual([RU]);
    expect(result.handoff).toContain('фото');
    expect(result.handoff).toContain('ИИ не видит');
    expect((await conversationRow()).aiEnabled).toBe(false);
    const [log] = await replyLog();
    expect(log).toMatchObject({ outcome: 'handoff', promptTokens: 0, cost: '0.00000000' });
  });

  it('hands off a burst of voice notes and photos, in the language the customer wrote before', async () => {
    await say('client', 'Сәлеметсіз бе');
    await say('ai', 'Сәлеметсіз бе! Қандай мөр керек?');
    await say('client', null, 'audio');
    await say('client', null, 'image');
    await say('client', null, 'image');
    const model = fakeModel(answer());

    const result = await turn(model);

    expect(model.calls).toHaveLength(0);
    expect(customerSends()).toEqual([KK]);
    expect(result.handoff).toContain('голосовое сообщение, фото (2 шт.)');
  });

  it('calls the model when the photo came with a caption', async () => {
    await say('client', 'Вот такой дизайн можно?', 'image');
    const model = fakeModel(answer({ reply: 'Опишите, пожалуйста, дизайн словами.' }));

    await turn(model);

    expect(model.calls).toHaveLength(1);
    expect(customerSends()).toEqual(['Опишите, пожалуйста, дизайн словами.']);
  });

  it('calls the model for a voice note that was transcribed', async () => {
    await say('client', 'Мне нужна печать для ИП', 'audio');
    const model = fakeModel(answer());

    await turn(model);

    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]?.messages.at(-1)?.content).toContain('расшифровка');
  });

  it('calls the model when text came alongside the photo', async () => {
    await say('client', 'Какой из этих?');
    await say('client', null, 'image');
    const model = fakeModel(answer());

    await turn(model);

    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]?.messages.at(-1)?.content).toBe('Клиент: [клиент прислал фото — содержимое тебе не видно]');
  });
});

describe('the history window counts lines, not rows', () => {
  it('keeps an agreed price in view behind a burst of catalog photos', async () => {
    await say('client', 'Договорились на 45000, адрес Абая 10');
    for (let i = 0; i < 30; i += 1) await say('operator', null, 'image');
    await say('client', 'Когда будет готово?');
    const model = fakeModel(answer());

    await turn(model);

    const contents = model.calls[0]!.messages.slice(1).map((message) => message.content);
    expect(contents).toEqual([
      'Клиент: Договорились на 45000, адрес Абая 10',
      'Оператор: [отправлено: фото (30 шт.)]',
      'Клиент: Когда будет готово?',
    ]);
  });
});

describe('holding helpers', () => {
  it('decides the language like rule 3 does', () => {
    expect(holdingLanguage('auto', [{ author: 'client', body: 'Бағасы қанша?' }])).toBe('kk');
    expect(holdingLanguage('auto', [{ author: 'client', body: 'Мөр керек' }, { author: 'client', body: 'Сколько?' }])).toBe('ru');
    expect(holdingLanguage('auto', [{ author: 'client', body: 'Мөр керек' }, { author: 'client', body: null, kind: 'image' }])).toBe('kk');
    expect(holdingLanguage('Русский', [{ author: 'client', body: 'Бағасы қанша?' }])).toBe('ru');
    expect(holdingLanguage('казахский', [{ author: 'client', body: 'Цена?' }])).toBe('kk');
    expect(holdingLanguage('auto', [])).toBe('ru');
  });

  it('sees a holding line nobody has spoken past', () => {
    expect(alreadyHolding([{ author: 'client', body: 'Цена?' }, { author: 'ai', body: RU }])).toBe(true);
    expect(alreadyHolding([{ author: 'ai', body: KK }, { author: 'system', body: 'Автосообщение' }])).toBe(true);
    expect(alreadyHolding([{ author: 'ai', body: RU }, { author: 'client', body: 'Ну?' }])).toBe(false);
    expect(alreadyHolding([{ author: 'ai', body: RU }, { author: 'operator', body: 'Здравствуйте' }])).toBe(false);
  });

  it('finds only a turn that is nothing but bare attachments', () => {
    expect(unseenSinceLastReply([{ author: 'ai', body: 'Да' }, { author: 'client', body: null, kind: 'sticker' }]))
      .toHaveLength(1);
    expect(unseenSinceLastReply([{ author: 'client', body: 'Вот', kind: 'text' }, { author: 'client', body: null, kind: 'image' }]))
      .toBeNull();
    expect(unseenSinceLastReply([{ author: 'client', body: null, kind: 'location' }])).toBeNull();
    expect(unseenSinceLastReply([{ author: 'ai', body: 'Да' }])).toBeNull();
  });
});
