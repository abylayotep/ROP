import { rm } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agents, conversations, messages, whatsappEvents, whatsappNumbers } from '../src/db/schema.js';
import { createAccountWithOwner } from '../src/lib/provision.js';
import { encryptSecret } from '../src/lib/secret-box.js';
import { processPendingEvents } from '../src/lib/whatsapp/inbound.js';
import { withDb } from './helpers/db.js';
import { testEnv } from './helpers/env.js';
import { fakeGraph, type FakeGraph } from './helpers/fake-graph.js';
import { fakeModel, type FakeModel } from './helpers/fake-model.js';
import { fakeLinked } from './helpers/fake-linked.js';

const env = testEnv();
const key = Buffer.from(env.CREDENTIALS_KEY, 'base64');

let db: Awaited<ReturnType<typeof withDb>>;
let agentId: string;
let model: FakeModel;
let graph: FakeGraph;

const deps = () => ({ graph, linked: fakeLinked(), key, mediaDir: env.MEDIA_DIR, model });

beforeEach(async () => {
  db = await withDb();
  model = fakeModel();
  graph = fakeGraph();
  const { accountId } = await createAccountWithOwner(db, {
    company: 'Sealhouse',
    email: 'owner@example.com',
    name: 'Владелец',
    initials: 'ВЛ',
    password: 'correct-horse-battery',
  });
  const [agent] = await db.insert(agents).values({ accountId, name: 'Sealhouse' }).returning();
  agentId = agent!.id;
  await db.insert(whatsappNumbers).values({
    agentId,
    phoneNumberId: '136',
    wabaId: '932',
    displayPhone: '+7 771 523 03 42',
    accessToken: encryptSecret('EAAB-token', key, '136'),
    connectionKind: 'coexistence',
  });
});

afterEach(async () => {
  await rm(env.MEDIA_DIR, { recursive: true, force: true });
});

/** One delivery of one change, in the envelope Meta uses for every field. */
const change = (field: string, value: Record<string, unknown>) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: '932', changes: [{ field, value }] }],
});

const meta = { messaging_product: 'whatsapp', metadata: { display_phone_number: '77715230342', phone_number_id: '136' } };

const store = (payload: unknown) => db.insert(whatsappEvents).values({ payload });

const history = (
  chunks: { phase: number; chunk_order: number; progress: number; threads: unknown[] }[],
) =>
  change('history', {
    ...meta,
    history: chunks.map(({ threads, ...metadata }) => ({ metadata, threads })),
  });

const thread = (id: string, msgs: Record<string, unknown>[]) => ({ id, messages: msgs });

const inbound = (id: string, body: string, ts: string) => ({
  from: '77771234567',
  id,
  timestamp: ts,
  type: 'text',
  text: { body },
  history_context: { status: 'READ' },
});

const outbound = (id: string, body: string, ts: string) => ({
  from: '77715230342',
  to: '77771234567',
  id,
  timestamp: ts,
  type: 'text',
  text: { body },
  history_context: { status: 'DELIVERED' },
});

describe('history import', () => {
  it('stores a thread with both directions, moves last_message_at, opens no window, runs no turn', async () => {
    await store(history([{ phase: 0, chunk_order: 1, progress: 40, threads: [
      thread('77771234567', [inbound('wamid.H1', 'Здравствуйте', '1750000000'), outbound('wamid.H2', 'Добрый день', '1750000060')]),
    ] }]));

    expect(await processPendingEvents(db, deps())).toEqual({ processed: 1, failed: 0 });

    const rows = await db.select().from(messages).orderBy(messages.sentAt);
    expect(rows.map((m) => [m.waMessageId, m.direction, m.author, m.status])).toEqual([
      ['wamid.H1', 'in', 'client', null],
      ['wamid.H2', 'out', 'phone', 'delivered'],
    ]);
    const [conversation] = await db.select().from(conversations);
    expect(conversation!.lastInboundAt).toBeNull();
    expect(conversation!.lastMessageAt?.toISOString()).toBe('2025-06-15T15:07:40.000Z');
    expect(conversation!.aiEnabled).toBe(true);
    expect(model.calls).toHaveLength(0);
    const [number] = await db.select().from(whatsappNumbers);
    expect(number!.historyProgress).toBe(40);
  });

  it('accepts chunks out of order and a redelivered chunk adds nothing', async () => {
    const second = history([{ phase: 1, chunk_order: 2, progress: 100, threads: [thread('77771234567', [inbound('wamid.H3', 'Спасибо', '1740000000')])] }]);
    const first = history([{ phase: 1, chunk_order: 1, progress: 70, threads: [thread('77771234567', [inbound('wamid.H1', 'Здравствуйте', '1750000000')])] }]);
    await store(second);
    await store(first);
    await store(second);

    await processPendingEvents(db, deps());

    expect(await db.select().from(messages)).toHaveLength(2);
    const [number] = await db.select().from(whatsappNumbers);
    // Progress only grows: the 70 that arrived after the 100 must not pull it back.
    expect(number!.historyProgress).toBe(100);
  });

  it('stores a media placeholder as an unsupported message with an explanation', async () => {
    await store(history([{ phase: 0, chunk_order: 1, progress: 100, threads: [thread('77771234567', [
      { from: '77771234567', id: 'wamid.M1', timestamp: '1750000000', type: 'media_placeholder', history_context: { status: 'READ' } },
    ])] }]));

    await processPendingEvents(db, deps());

    const [message] = await db.select().from(messages);
    expect(message).toMatchObject({ kind: 'unsupported', body: 'Файл из истории телефона', mediaPath: null });
  });

  it('fills a placeholder from a follow-up chunk that carries the real media', async () => {
    await store(history([{ phase: 0, chunk_order: 1, progress: 50, threads: [thread('77771234567', [
      { from: '77771234567', id: 'wamid.M1', timestamp: '1750000000', type: 'media_placeholder', history_context: { status: 'READ' } },
    ])] }]));
    await processPendingEvents(db, deps());

    await store(history([{ phase: 0, chunk_order: 2, progress: 60, threads: [thread('77771234567', [
      { from: '77771234567', id: 'wamid.M1', timestamp: '1750000000', type: 'image', image: { id: 'media-1', mime_type: 'image/jpeg' }, history_context: { status: 'READ' } },
    ])] }]));
    expect(await processPendingEvents(db, deps())).toEqual({ processed: 1, failed: 0 });

    const rows = await db.select().from(messages);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'image', mediaMime: 'image/jpeg' });
    expect(rows[0]!.mediaPath).toBe(`${agentId}/wamid.M1.jpg`);
    expect(graph.calls.map((c) => c.method)).toEqual(['getMediaUrl', 'downloadMedia']);
  });

  it('records that the owner declined history sharing', async () => {
    await store(change('history', {
      ...meta,
      history: [{ errors: [{ code: 2593109, title: 'History sync is turned off by the business from the WhatsApp Business App', message: 'History sync is turned off by the business from the WhatsApp Business App' }] }],
    }));

    expect(await processPendingEvents(db, deps())).toEqual({ processed: 1, failed: 0 });

    const [number] = await db.select().from(whatsappNumbers);
    expect(number!.historyDeclinedAt).not.toBeNull();
    expect(await db.select().from(messages)).toHaveLength(0);
  });

  it('ignores a thread whose id is not a phone', async () => {
    await store(history([{ phase: 0, chunk_order: 1, progress: 100, threads: [thread('120363012345678901@g.us', [inbound('wamid.G1', 'group', '1750000000')])] }]));

    await processPendingEvents(db, deps());

    expect(await db.select().from(messages)).toHaveLength(0);
  });
});
