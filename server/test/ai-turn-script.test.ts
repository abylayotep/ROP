import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client.js';
import {
  agents,
  aiSandboxSessions,
  contacts,
  conversations,
  messages,
  orders,
  productPhotos,
  products,
  productVariants,
  salesScriptSteps,
  whatsappNumbers,
} from '../src/db/schema.js';
import { storeProductPhoto } from '../src/lib/catalog/products.js';
import { runScriptPaymentTurns } from '../src/lib/ai/script-payment.js';
import { afterPaymentPhotoIds, passesUnpaidPayment } from '../src/lib/ai/sales-script.js';
import { runSimulatorTurn } from '../src/lib/ai/simulator.js';
import { runTurn, type TurnDeps } from '../src/lib/ai/turn.js';
import { createAccountWithOwner } from '../src/lib/provision.js';
import { encryptSecret } from '../src/lib/secret-box.js';
import type { GraphClient } from '../src/lib/whatsapp/graph.js';
import { withDb } from './helpers/db.js';
import { testEnv } from './helpers/env.js';
import { fakeGraph, type FakeGraph } from './helpers/fake-graph.js';
import { fakeLinked } from './helpers/fake-linked.js';
import { fakeModel, type FakeModel } from './helpers/fake-model.js';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 9)]);

let db: Db;
let mediaDir: string;
let key: Buffer;
let env: ReturnType<typeof testEnv>;
let accountId: string;
let agentId: string;
let conversationId: string;
let graph: FakeGraph;
let media: string[];
let designsPhoto: string;
let donePhoto: string;
const step = { hello: '', designs: '', pay: '', after: '' };

function answer(over: Record<string, unknown> = {}): string {
  return JSON.stringify({ reply: 'Вот наши дизайны.', stageId: null, fields: {}, handoff: null,
    photoIds: [], usedItemIds: [], scriptStepId: null, ...over });
}

const deps = (model: FakeModel): TurnDeps => ({ model, graph, linked: fakeLinked(), key, env });

const conversation = async () => (await db.select().from(conversations).where(eq(conversations.id, conversationId)))[0]!;
const thread = () => db.select().from(messages).where(eq(messages.conversationId, conversationId))
  .orderBy(asc(messages.sentAt), asc(messages.createdAt));

async function addPhoto(productId: string): Promise<string> {
  const id = randomUUID();
  const mediaPath = await storeProductPhoto(mediaDir, { agentId, photoId: id, bytes: JPEG, mime: 'image/jpeg' });
  await db.insert(productPhotos).values({ id, productId, mediaPath, mediaMime: 'image/jpeg', sizeBytes: JPEG.length, filename: 'p.jpg' });
  return id;
}

async function say(author: 'client' | 'ai' | 'operator', body: string, ago = 0): Promise<void> {
  const sentAt = new Date(Date.now() - ago);
  await db.insert(messages).values({ conversationId, direction: author === 'client' ? 'in' : 'out', author, kind: 'text', body, sentAt });
  if (author === 'client') await db.update(conversations).set({ lastInboundAt: sentAt }).where(eq(conversations.id, conversationId));
}

beforeEach(async () => {
  db = await withDb();
  mediaDir = await mkdtemp(join(tmpdir(), 'rakurs-turn-script-'));
  env = testEnv({ MEDIA_DIR: mediaDir });
  key = Buffer.from(env.CREDENTIALS_KEY, 'base64');
  ({ accountId } = await createAccountWithOwner(db, {
    company: 'Sealhouse', email: 'owner@turn-script.test', name: 'Owner', initials: 'OW', password: 'correct-horse-battery',
  }));
  agentId = randomUUID();
  await db.insert(agents).values({ id: agentId, accountId, name: 'Sealhouse', aiEnabled: true, responseMode: 'live',
    openrouterKey: encryptSecret('sk-or-script', key, agentId) });
  const [number] = await db.insert(whatsappNumbers).values({ agentId, phoneNumberId: '137', wabaId: 'waba',
    displayPhone: '+7 700 000 00 01', accessToken: encryptSecret('EAAG-token', key, '137') }).returning();
  const [contact] = await db.insert(contacts).values({ agentId, phone: '77000000001', name: 'Айгерим' }).returning();
  const [row] = await db.insert(conversations).values({ agentId, contactId: contact!.id, whatsappNumberId: number!.id,
    lastInboundAt: new Date(Date.now() - 60 * 60_000) }).returning();
  conversationId = row!.id;

  const [product] = await db.insert(products).values({ agentId, name: 'Экслибрис' }).returning();
  await db.insert(productVariants).values({ productId: product!.id, label: 'стандарт', price: 12000 });
  designsPhoto = await addPhoto(product!.id);
  donePhoto = await addPhoto(product!.id);

  const insert = async (title: string, position: number, over: Record<string, unknown> = {}) =>
    (await db.insert(salesScriptSteps).values({ agentId, title, position, ...over }).returning())[0]!.id;
  step.hello = await insert('Приветствие', 0);
  step.designs = await insert('Фото дизайнов', 1, { photoIds: [designsPhoto] });
  step.pay = await insert('Оплата', 2, { waitPayment: true, instructions: 'Стандартный размер 9990 ₸, скажи сумму.' });
  step.after = await insert('После оплаты', 3, { photoIds: [donePhoto] });

  media = [];
  const base = fakeGraph();
  const sendMedia: NonNullable<GraphClient['sendMedia']> = async (_numberId, _token, _to, file) => {
    media.push(file.path);
    return { messageId: `wamid.photo.${media.length}` };
  };
  graph = { ...base, sendMedia };
});

afterEach(async () => {
  await rm(mediaDir, { recursive: true, force: true });
});

describe('sales script in a live turn', () => {
  it('shows the script, stores the step the reply took and starts the sale', async () => {
    await say('client', 'Здравствуйте, хочу экслибрис');
    const model = fakeModel(answer({ scriptStepId: step.designs, photoIds: [designsPhoto] }));

    const result = await runTurn(db, deps(model), { agentId, conversationId });

    expect(result.outcome).toBe('sent');
    expect(result.photoIds).toEqual([designsPhoto]);
    const prompt = model.calls[0]!.messages[0]!.content;
    expect(prompt).toContain(`<шаг id="${step.designs}" номер="2"`);
    expect(prompt).toContain('Шаг ещё не выбран');
    expect(prompt).toContain('Оплата: не подтверждена.');
    const row = await conversation();
    expect(row.scriptStepId).toBe(step.designs);
    expect(row.scriptStartedAt).not.toBeNull();
  });

  it('ignores an unknown step and keeps the one the conversation is on', async () => {
    await db.update(conversations).set({ scriptStepId: step.designs, scriptStartedAt: new Date() }).where(eq(conversations.id, conversationId));
    await say('client', 'А ещё?');
    const result = await runTurn(db, deps(fakeModel(answer({ scriptStepId: 'made-up' }))), { agentId, conversationId });
    expect(result.outcome).toBe('sent');
    expect(result.detail).toContain('шаг скрипта, которого нет');
    expect((await conversation()).scriptStepId).toBe(step.designs);
  });

  it('does not flag a price the owner wrote into a step as invented', async () => {
    await db.update(conversations).set({ scriptStepId: step.pay, scriptStartedAt: new Date() }).where(eq(conversations.id, conversationId));
    await say('client', 'Сколько?');
    const result = await runTurn(db, deps(fakeModel(answer({ reply: 'Стандартный размер — 9 990 ₸.', scriptStepId: step.pay }))),
      { agentId, conversationId });
    expect(result.outcome).toBe('sent');
    expect(result.reply).toBe('Стандартный размер — 9 990 ₸.');
  });

  it('refuses to pass an unpaid payment step and keeps its after-payment photos back', async () => {
    await db.update(conversations).set({ scriptStepId: step.pay, scriptStartedAt: new Date() }).where(eq(conversations.id, conversationId));
    await say('client', 'Я оплатила');
    const result = await runTurn(db, deps(fakeModel(answer({ reply: 'Спасибо! Проверим поступление.',
      scriptStepId: step.after, photoIds: [donePhoto] }))), { agentId, conversationId });

    expect(result.outcome).toBe('sent');
    expect(result.photoIds).toEqual([]);
    expect(media).toHaveLength(0);
    expect(result.detail).toContain('Шаг скрипта не изменён');
    expect(result.detail).toContain('Фото шагов после оплаты не отправлены');
    expect((await conversation()).scriptStepId).toBe(step.pay);
  });

  it('counts an order of an earlier sale as unpaid, and one of this sale as paid', async () => {
    const started = new Date(Date.now() - 30 * 60_000);
    await db.update(conversations).set({ scriptStepId: step.pay, scriptStartedAt: started }).where(eq(conversations.id, conversationId));
    const old = new Date(Date.now() - 24 * 60 * 60_000);
    await db.insert(orders).values({ agentId, conversationId, amount: '9990', currency: 'KZT', status: 'paid', paidAt: old, createdAt: old });
    await say('client', 'Оплатила');
    const model = fakeModel(answer({ reply: 'Проверим.', scriptStepId: step.pay }));
    await runTurn(db, deps(model), { agentId, conversationId });
    expect(model.calls[0]!.messages[0]!.content).toContain('Оплата: не подтверждена.');

    // A chat order backdated before the sale started still counts: it was recorded now.
    const [order] = await db.insert(orders).values({ agentId, conversationId, amount: '9990', currency: 'KZT', status: 'paid',
      paidAt: new Date(started.getTime() - 60_000) }).returning();
    await say('client', 'Вот чек');
    const paid = fakeModel(answer({ reply: 'Спасибо за оплату! Вот ваша печать.', scriptStepId: step.after, photoIds: [donePhoto] }));
    const result = await runTurn(db, deps(paid), { agentId, conversationId });
    expect(paid.calls[0]!.messages[0]!.content).toContain('Оплата: подтверждена системой.');
    expect(result.photoIds).toEqual([donePhoto]);
    expect((await conversation()).scriptStepId).toBe(step.after);
    // The customer's turn acted on this payment, so no payment turn will.
    const [claimed] = await db.select().from(orders).where(eq(orders.id, order!.id));
    expect(claimed!.scriptPaymentTurnAt).not.toBeNull();
    expect(await runScriptPaymentTurns(db, deps(paid))).toEqual([]);
  });
});

describe('the turn a payment starts', () => {
  async function standOnPayment(): Promise<string> {
    await db.update(conversations).set({ scriptStepId: step.pay, scriptStartedAt: new Date(Date.now() - 30 * 60_000) })
      .where(eq(conversations.id, conversationId));
    await say('client', 'Беру стандарт', 20 * 60_000);
    await say('ai', 'Счёт на 9 990 ₸ отправлен.', 19 * 60_000);
    const [order] = await db.insert(orders).values({ agentId, conversationId, amount: '9990', currency: 'KZT',
      status: 'paid', paidAt: new Date() }).returning();
    return order!.id;
  }

  it('moves past the payment step, sends its photos, and sends once however often payment is seen', async () => {
    const orderId = await standOnPayment();
    const model = fakeModel(answer({ reply: 'Спасибо за оплату! Вот ваша готовая печать.', scriptStepId: step.after, photoIds: [donePhoto] }));

    const first = await runScriptPaymentTurns(db, deps(model));
    expect(first).toHaveLength(1);
    expect(first[0]!.orderId).toBe(orderId);
    expect(first[0]!.result?.outcome).toBe('sent');
    const prompt = model.calls[0]!.messages[0]!.content;
    expect(prompt).toContain('Оплата: подтверждена системой.');
    expect(prompt).toContain('этот ответ запускает система');
    expect(media).toHaveLength(1);
    expect((await conversation()).scriptStepId).toBe(step.after);

    // Seen again — the next pass, or Kaspi and the chat both recognising it.
    expect(await runScriptPaymentTurns(db, deps(model))).toEqual([]);
    expect(await runTurn(db, deps(model), { agentId, conversationId, paidOrderId: orderId }))
      .toMatchObject({ outcome: 'skipped' });
    expect(model.calls).toHaveLength(1);
    expect((await thread()).filter((row) => row.author === 'ai')).toHaveLength(3);
  });

  it('leaves a payment to the turn of a customer who has just written, without claiming it', async () => {
    const orderId = await standOnPayment();
    await say('client', 'Оплатила!');
    const model = fakeModel(answer());
    expect(await runScriptPaymentTurns(db, deps(model))).toEqual([{ orderId, conversationId, result: null, claimed: false }]);
    expect(model.calls).toHaveLength(0);
  });

  it('claims and drops a payment while an operator is on the thread or automation is off', async () => {
    const orderId = await standOnPayment();
    await say('operator', 'Здравствуйте, это Марат.');
    const model = fakeModel(answer());
    expect(await runScriptPaymentTurns(db, deps(model))).toEqual([{ orderId, conversationId, result: null, claimed: true }]);
    expect(model.calls).toHaveLength(0);
  });

  it('does not run when automation is off, and not later when it comes back on', async () => {
    await standOnPayment();
    await db.update(agents).set({ responseMode: 'off' }).where(eq(agents.id, agentId));
    const model = fakeModel(answer());
    expect((await runScriptPaymentTurns(db, deps(model)))[0]).toMatchObject({ result: null, claimed: true });
    await db.update(agents).set({ responseMode: 'live' }).where(eq(agents.id, agentId));
    expect(await runScriptPaymentTurns(db, deps(model))).toEqual([]);
    expect(model.calls).toHaveLength(0);
  });

  it('ignores a payment for a conversation not on a payment step', async () => {
    await standOnPayment();
    await db.update(conversations).set({ scriptStepId: step.designs }).where(eq(conversations.id, conversationId));
    expect(await runScriptPaymentTurns(db, deps(fakeModel(answer())))).toEqual([]);
  });
});

describe('sales script in the browser simulator', () => {
  it('remembers the step in the session', async () => {
    const [session] = await db.insert(aiSandboxSessions).values({ agentId, accountId, title: 'Скрипт' }).returning();
    const model = fakeModel(answer({ scriptStepId: step.designs }), answer({ scriptStepId: step.designs }));
    await runSimulatorTurn(db, deps(model), { agentId, sessionId: session!.id, text: 'Здравствуйте', revision: 0 });
    const [stored] = await db.select().from(aiSandboxSessions).where(eq(aiSandboxSessions.id, session!.id));
    expect(stored!.scriptStepId).toBe(step.designs);
    await runSimulatorTurn(db, deps(model), { agentId, sessionId: session!.id, text: 'Покажите', revision: 1 });
    expect(model.calls[1]!.messages[0]!.content).toContain('Текущий шаг: 2 «Фото дизайнов»');
  });
});

describe('script gates', () => {
  const s = (id: string, parentId: string | null, over: { photoIds?: string[]; waitPayment?: boolean } = {}) =>
    ({ id, parentId, photoIds: over.photoIds ?? [], waitPayment: over.waitPayment ?? false });
  const script = [s('a', null, { photoIds: ['p1'] }), s('pay', null, { waitPayment: true }),
    s('pay-q', 'pay'), s('after', null, { photoIds: ['p1', 'p2'] }), s('after-b', 'after', { photoIds: ['p3'] })];

  it('blocks only moves past an unpaid payment step', () => {
    expect(passesUnpaidPayment(script, 'a', 'pay')).toBe(false);
    expect(passesUnpaidPayment(script, 'pay', 'pay-q')).toBe(false);
    expect(passesUnpaidPayment(script, 'pay', 'after')).toBe(true);
    expect(passesUnpaidPayment(script, null, 'after-b')).toBe(true);
    expect(passesUnpaidPayment(script, 'after', 'a')).toBe(false);
    expect(passesUnpaidPayment(script, 'after', 'after-b')).toBe(false);
  });

  it('holds back photos that appear only after the payment step', () => {
    expect([...afterPaymentPhotoIds(script)].sort()).toEqual(['p2', 'p3']);
    expect(afterPaymentPhotoIds([s('a', null, { photoIds: ['p1'] })]).size).toBe(0);
  });
});
