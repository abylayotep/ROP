import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
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
  productPhotos,
  products,
  productVariants,
  whatsappNumbers,
} from '../src/db/schema.js';
import { storeProductPhoto } from '../src/lib/catalog/products.js';
import { runSimulatorTurn } from '../src/lib/ai/simulator.js';
import { runTurn, type TurnDeps } from '../src/lib/ai/turn.js';
import { createAccountWithOwner } from '../src/lib/provision.js';
import { encryptSecret } from '../src/lib/secret-box.js';
import type { GraphClient } from '../src/lib/whatsapp/graph.js';
import type { OutgoingFile } from '../src/lib/whatsapp/linked/client.js';
import { withDb } from './helpers/db.js';
import { testEnv } from './helpers/env.js';
import { fakeGraph, type FakeGraph } from './helpers/fake-graph.js';
import { fakeLinked } from './helpers/fake-linked.js';
import { fakeModel, type FakeModel } from './helpers/fake-model.js';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 9)]);

let db: Db;
let mediaDir: string;
let env: ReturnType<typeof testEnv>;
let key: Buffer;
let accountId: string;
let agentId: string;
let conversationId: string;
let productId: string;
let photoIds: string[];
let graph: FakeGraph;
let media: { to: unknown; file: OutgoingFile }[];
let failMedia: Error | null;

function answer(over: Record<string, unknown> = {}): string {
  return JSON.stringify({ reply: 'Вот дверь «Гранит», 85 000 ₸.', stageId: null, fields: {}, handoff: null,
    usedItemIds: [], ...over });
}

function deps(model: FakeModel): TurnDeps {
  return { model, graph, linked: fakeLinked(), key, env };
}

async function addPhoto(target: string, owner = agentId): Promise<string> {
  const id = randomUUID();
  const mediaPath = await storeProductPhoto(mediaDir, { agentId: owner, photoId: id, bytes: JPEG, mime: 'image/jpeg' });
  await db.insert(productPhotos).values({ id, productId: target, mediaPath, mediaMime: 'image/jpeg',
    sizeBytes: JPEG.length, filename: 'door.jpg', caption: 'Вид спереди' });
  return id;
}

const thread = () => db.select().from(messages).where(eq(messages.conversationId, conversationId))
  .orderBy(asc(messages.sentAt), asc(messages.createdAt));

beforeEach(async () => {
  db = await withDb();
  mediaDir = await mkdtemp(join(tmpdir(), 'rakurs-turn-photos-'));
  env = testEnv({ MEDIA_DIR: mediaDir });
  key = Buffer.from(env.CREDENTIALS_KEY, 'base64');
  ({ accountId } = await createAccountWithOwner(db, {
    company: 'Двери', email: 'owner@photos.test', name: 'Owner', initials: 'OW', password: 'correct-horse-battery',
  }));
  agentId = randomUUID();
  await db.insert(agents).values({ id: agentId, accountId, name: 'Двери', aiEnabled: true, responseMode: 'live',
    openrouterKey: encryptSecret('sk-or-photos', key, agentId) });
  const [number] = await db.insert(whatsappNumbers).values({ agentId, phoneNumberId: '136', wabaId: 'waba',
    displayPhone: '+7 708 580 79 32', accessToken: encryptSecret('EAAG-token', key, '136') }).returning();
  const [contact] = await db.insert(contacts).values({ agentId, phone: '77085807932', name: 'Айгуль' }).returning();
  const [conversation] = await db.insert(conversations).values({ agentId, contactId: contact!.id,
    whatsappNumberId: number!.id, lastInboundAt: new Date(Date.now() - 60_000) }).returning();
  conversationId = conversation!.id;
  await db.insert(messages).values({ conversationId, direction: 'in', author: 'client', kind: 'text',
    body: 'Покажите дверь Гранит', sentAt: new Date(Date.now() - 60_000) });

  const [product] = await db.insert(products).values({ agentId, name: 'Дверь «Гранит»',
    description: 'Металлическая' }).returning();
  productId = product!.id;
  await db.insert(productVariants).values({ productId, label: '40 мм', price: 85000 });
  photoIds = [];
  for (let i = 0; i < 4; i += 1) photoIds.push(await addPhoto(productId));

  media = [];
  failMedia = null;
  const base = fakeGraph();
  const sendMedia: NonNullable<GraphClient['sendMedia']> = async (_numberId, _token, to, file) => {
    if (failMedia) throw failMedia;
    media.push({ to, file });
    return { messageId: `wamid.photo.${media.length}` };
  };
  graph = { ...base, sendMedia };
});

afterEach(async () => {
  await rm(mediaDir, { recursive: true, force: true });
});

describe('catalog photos in a live turn', () => {
  it('tells the model the catalog and sends the chosen photos after the text, each as its own message', async () => {
    const model = fakeModel(answer({ photoIds: [photoIds[0], photoIds[1]] }));

    const result = await runTurn(db, deps(model), { agentId, conversationId });

    expect(result.outcome).toBe('sent');
    expect(result.photoIds).toEqual([photoIds[0], photoIds[1]]);
    expect(result.detail).toBeNull();
    const prompt = model.calls[0]!.messages[0]!.content;
    expect(prompt).toContain(`<товар id="${productId}"`);
    expect(prompt).toContain('- 40 мм: 85 000 ₸');
    expect(prompt).toContain(`- [${photoIds[0]}] Вид спереди`);

    expect(graph.calls.map((call) => call.method)).toEqual(['sendText']);
    expect(media).toHaveLength(2);
    expect(media[0]!.to).toBe('77085807932');
    const rows = await thread();
    expect(rows.map((row) => [row.author, row.kind, row.productPhotoId])).toEqual([
      ['client', 'text', null],
      ['ai', 'text', null],
      ['ai', 'image', photoIds[0]],
      ['ai', 'image', photoIds[1]],
    ]);
    // The message owns a copy, so the thread still shows the photo after the catalog loses it.
    const image = rows[2]!;
    expect(image.waMessageId).toBe('wamid.photo.1');
    expect(image.mediaMime).toBe('image/jpeg');
    expect(join(mediaDir, image.mediaPath!)).toBe(media[0]!.file.path);
    await db.delete(productPhotos).where(eq(productPhotos.id, photoIds[0]!));
    expect(existsSync(join(mediaDir, image.mediaPath!))).toBe(true);
  });

  it('drops unknown, foreign, inactive and already-sent photos and caps the rest at three', async () => {
    const [foreignAgent] = await db.insert(agents).values({ accountId, name: 'Чужой' }).returning();
    const [foreignProduct] = await db.insert(products).values({ agentId: foreignAgent!.id, name: 'Чужая' }).returning();
    const foreign = await addPhoto(foreignProduct!.id, foreignAgent!.id);
    const [hidden] = await db.insert(products).values({ agentId, name: 'Снята', active: false }).returning();
    const inactive = await addPhoto(hidden!.id);

    await runTurn(db, deps(fakeModel(answer({ photoIds: [photoIds[0]] }))), { agentId, conversationId });
    expect(media).toHaveLength(1);
    await db.insert(messages).values({ conversationId, direction: 'in', author: 'client', kind: 'text',
      body: 'А ещё фото?', sentAt: new Date() });
    await db.update(conversations).set({ lastInboundAt: new Date() }).where(eq(conversations.id, conversationId));

    const extra = await addPhoto(productId);
    const model = fakeModel(answer({
      photoIds: ['made-up', foreign, inactive, photoIds[0], photoIds[1], photoIds[2], photoIds[3], extra],
    }));
    const result = await runTurn(db, deps(model), { agentId, conversationId });

    expect(result.outcome).toBe('sent');
    expect(result.photoIds).toEqual([photoIds[1], photoIds[2], photoIds[3]]);
    expect(media.slice(1)).toHaveLength(3);
    expect(result.detail).toContain('Модель назвала фото, которых нет в каталоге: made-up');
    expect(result.detail).toContain('Фото уже отправлялись в этом диалоге: 1.');
    expect(result.detail).toContain('отправляются первые 3');
    // The second prompt knew which photo the customer already had.
    expect(model.calls[0]!.messages[0]!.content).toContain(`- [${photoIds[0]}] Вид спереди (уже отправлено)`);
  });

  it('sends nothing in a dry run but reports what would go', async () => {
    const result = await runTurn(db, deps(fakeModel(answer({ photoIds: [photoIds[0]] }))),
      { agentId, conversationId, dryRun: true });

    expect(result.photoIds).toEqual([photoIds[0]]);
    expect(media).toHaveLength(0);
    expect(graph.calls).toHaveLength(0);
    expect(await thread()).toHaveLength(1);
  });

  it('keeps the text outcome when a photo fails, stops the rest and says why', async () => {
    failMedia = new Error('media upload refused');
    const result = await runTurn(db, deps(fakeModel(answer({ photoIds: [photoIds[0], photoIds[1]] }))),
      { agentId, conversationId });

    expect(result.outcome).toBe('sent');
    expect(result.photoIds).toEqual([]);
    expect(result.detail).toContain('Фото не отправлено:');
    expect(result.detail).toContain('media upload refused');
    const rows = await thread();
    expect(rows.map((row) => row.kind)).toEqual(['text', 'text']);
  });

  it('sends no photos with a reply that is withheld', async () => {
    const result = await runTurn(db, deps(fakeModel(answer({ reply: 'Скидка 12345 ₸.', photoIds: [photoIds[0]] }))),
      { agentId, conversationId });

    expect(result.outcome).toBe('handoff');
    expect(result.photoIds).toEqual([]);
    expect(media).toHaveLength(0);
  });

  it('sends no photos when automation is switched off before the send', async () => {
    const model: FakeModel = {
      ...fakeModel(),
      calls: [],
      async complete(input) {
        this.calls.push(input);
        await db.update(agents).set({ responseMode: 'off' }).where(eq(agents.id, agentId));
        return { text: answer({ photoIds: [photoIds[0]] }), promptTokens: 1, completionTokens: 1, cost: '0' };
      },
    };
    const result = await runTurn(db, deps(model), { agentId, conversationId });

    expect(result.outcome).toBe('skipped');
    expect(media).toHaveLength(0);
  });

  it('treats a catalog price as sourced', async () => {
    const result = await runTurn(db, deps(fakeModel(answer())), { agentId, conversationId });
    expect(result.outcome).toBe('sent');
  });
});

describe('catalog photos in the browser simulator', () => {
  it('reports the photos a reply would send, never sends, and remembers them for the next turn', async () => {
    const [session] = await db.insert(aiSandboxSessions).values({ agentId, accountId, title: 'Фото' }).returning();
    const model = fakeModel(answer({ photoIds: [photoIds[0], 'nope'] }));

    const first = await runSimulatorTurn(db, deps(model), { agentId, sessionId: session!.id, text: 'Покажите', revision: 0 });

    expect(first.photos).toEqual([{ id: photoIds[0], productId, productName: 'Дверь «Гранит»' }]);
    expect(media).toHaveLength(0);
    expect(graph.calls).toHaveLength(0);

    await runSimulatorTurn(db, deps(model), { agentId, sessionId: session!.id, text: 'Ещё', revision: 1 });
    expect(model.calls[1]!.messages[0]!.content).toContain(`- [${photoIds[0]}] Вид спереди (уже отправлено)`);
  });
});
