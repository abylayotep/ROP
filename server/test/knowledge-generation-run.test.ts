import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { agents, contacts, conversations, kbDrafts, kbGenerationBatches, kbGenerationProposals, kbGenerationRuns, messages, users, whatsappNumbers, accounts } from '../src/db/schema.js';
import { keyAad } from '../src/lib/ai/turn.js';
import { cancelGenerationRun, executeGenerationRun, reconcileGenerationRuns, retryGenerationRun, startGenerationRun } from '../src/lib/knowledge/generation-run.js';
import { previewSelection } from '../src/lib/knowledge/generation-selection.js';
import { encryptSecret } from '../src/lib/secret-box.js';
import { withDb } from './helpers/db.js';
import { testEnv } from './helpers/env.js';
import { fakeModel } from './helpers/fake-model.js';

let db: Awaited<ReturnType<typeof withDb>>;
let agentId: string;
let userId: string;
let conversationId: string;
let messageId: string;
const key = Buffer.alloc(32, 7);
const classified = (
  proposals: unknown[] = [],
  classification: 'customer' | 'irrelevant' | 'uncertain' = 'customer',
  reason = 'The client asks about delivery and the seller answers.',
) => JSON.stringify({ classification: { value: classification, reason }, proposals });

beforeEach(async () => {
  db = await withDb();
  const [account] = await db.insert(accounts).values({ name: 'Runs' }).returning();
  const [user] = await db.insert(users).values({ email: 'runs@example.test', passwordHash: 'x', name: 'Owner', initials: 'OW' }).returning();
  userId = user!.id;
  const [agent] = await db.insert(agents).values({ accountId: account!.id, name: 'Agent' }).returning();
  agentId = agent!.id;
  await db.update(agents).set({ openrouterKey: encryptSecret('provider-key', key, keyAad(agentId)) }).where(eq(agents.id, agentId));
  const [number] = await db.insert(whatsappNumbers).values({ agentId, phoneNumberId: 'run-number', wabaId: 'waba', displayPhone: '+7', accessToken: 'x' }).returning();
  const [contact] = await db.insert(contacts).values({ agentId, phone: '77000000003' }).returning();
  const [conversation] = await db.insert(conversations).values({ agentId, contactId: contact!.id, whatsappNumberId: number!.id }).returning();
  conversationId = conversation!.id;
  await db.insert(messages).values({ conversationId, direction: 'in', author: 'client', kind: 'text', body: 'How long does delivery take?', sentAt: new Date('2026-09-01T09:59:00Z') });
  const [message] = await db.insert(messages).values({ conversationId, direction: 'out', author: 'operator', kind: 'text', body: 'Delivery takes two days', sentAt: new Date('2026-09-01T10:00:00Z') }).returning();
  messageId = message!.id;
});

async function admitted(requestKey = 'request') {
  const preview = await previewSelection(db, agentId, { conversationIds: [conversationId], from: '2026-09-01T00:00:00Z', to: '2026-09-02T00:00:00Z' }, userId);
  return startGenerationRun(db, agentId, userId, preview.previewId, requestKey);
}

describe('generation runs', () => {
  it('replays the same request key but refuses a different preview or a second active run', async () => {
    const firstPreview = await previewSelection(db, agentId, { conversationIds: [conversationId], from: '2026-09-01T00:00:00Z', to: '2026-09-02T00:00:00Z' }, userId);
    const same = await startGenerationRun(db, agentId, userId, firstPreview.previewId, 'stable-key');

    expect((await startGenerationRun(db, agentId, userId, firstPreview.previewId, 'stable-key')).id).toBe(same.id);

    const secondPreview = await previewSelection(db, agentId, { conversationIds: [conversationId], from: '2026-09-01T00:00:00Z', to: '2026-09-03T00:00:00Z' }, userId);
    await expect(startGenerationRun(db, agentId, userId, secondPreview.previewId, 'stable-key')).rejects.toMatchObject({ statusCode: 409 });
    await expect(startGenerationRun(db, agentId, userId, secondPreview.previewId, 'another-key')).rejects.toMatchObject({ statusCode: 409 });
  });

  it('claims a queued run once under concurrent executors', async () => {
    const run = await admitted();
    const model = fakeModel(classified([{ path: 'Delivery', body: 'Two days', sources: [], warnings: [] }]));
    await Promise.all([
      executeGenerationRun({ db, model, credentialsKey: key }, run.id),
      executeGenerationRun({ db, model, credentialsKey: key }, run.id),
    ]);
    expect(model.calls).toHaveLength(1);
  });

  it('rejects changed source content before a paid call', async () => {
    const run = await admitted();
    await db.update(messages).set({ body: 'Changed delivery terms' });
    const model = fakeModel('{}');
    await executeGenerationRun({ db, model, credentialsKey: key }, run.id);
    expect(model.calls).toHaveLength(0);
    expect((await db.select().from(kbGenerationRuns).where(eq(kbGenerationRuns.id, run.id)))[0]?.status).toBe('failed');
  });

  it('continues after a paid batch returns unusable structured output', async () => {
    const run = await admitted('unusable-output');
    const [firstBatch] = await db.select().from(kbGenerationBatches).where(eq(kbGenerationBatches.runId, run.id));
    await db.insert(kbGenerationBatches).values({
      runId: run.id,
      ordinal: 1,
      manifest: { ...firstBatch!.manifest, ordinal: 1 },
    });
    const model = fakeModel(
      JSON.stringify({ classification: { value: 'customer', reason: 'Customer conversation.' }, proposals: 'invalid' }),
      classified(),
    );

    await executeGenerationRun({ db, model, credentialsKey: key }, run.id);

    expect(model.calls).toHaveLength(2);
    expect(await db.select().from(kbGenerationBatches).where(eq(kbGenerationBatches.runId, run.id)))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ ordinal: 0, status: 'done', errorCode: 'invalid_output' }),
        expect.objectContaining({ ordinal: 1, status: 'done', errorCode: null }),
      ]));
    expect((await db.select().from(kbGenerationRuns).where(eq(kbGenerationRuns.id, run.id)))[0])
      .toMatchObject({ status: 'completed', promptTokens: 200, completionTokens: 40, cost: '0.00020000' });
  });

  it('records paid usage but discards proposals when cancellation wins the call', async () => {
    const run = await admitted();
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const model = fakeModel();
    model.complete = async (input) => {
      model.calls.push(input);
      await waiting;
      return { text: classified(), promptTokens: 9, completionTokens: 3, cost: '0.01000000' };
    };
    const execution = executeGenerationRun({ db, model, credentialsKey: key }, run.id);
    while (model.calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    await cancelGenerationRun(db, agentId, run.id);
    release();
    await execution;
    const [stored] = await db.select().from(kbGenerationRuns).where(eq(kbGenerationRuns.id, run.id));
    expect(stored).toMatchObject({ status: 'cancelled', promptTokens: 9, completionTokens: 3 });
    expect(await db.select().from(kbGenerationProposals)).toHaveLength(0);
  });

  it('marks interrupted runs and their running batches failed', async () => {
    const run = await admitted();
    await db.update(kbGenerationRuns).set({ status: 'running' }).where(eq(kbGenerationRuns.id, run.id));
    await db.update(kbGenerationBatches).set({ status: 'running' }).where(eq(kbGenerationBatches.runId, run.id));
    expect(await reconcileGenerationRuns(db)).toBe(1);
    expect((await db.select().from(kbGenerationBatches))[0]).toMatchObject({ status: 'failed', errorCode: 'interrupted' });
  });

  it('retries only unfinished batches, keeps cumulative usage, and caps each batch at two attempts', async () => {
    const run = await admitted('retry');
    const [firstBatch] = await db.select().from(kbGenerationBatches).where(eq(kbGenerationBatches.runId, run.id));
    await db.update(kbGenerationBatches).set({
      status: 'done', attempts: 1, promptTokens: 5, completionTokens: 2, cost: '0.01000000',
    }).where(eq(kbGenerationBatches.id, firstBatch!.id));
    const [retryBatch] = await db.insert(kbGenerationBatches).values({
      runId: run.id,
      ordinal: 1,
      manifest: { ...firstBatch!.manifest, ordinal: 1 },
      status: 'failed',
      attempts: 1,
      promptTokens: 7,
      completionTokens: 3,
      cost: '0.02000000',
      errorCode: 'provider_error',
    }).returning();
    await db.update(kbGenerationRuns).set({
      status: 'failed', promptTokens: 12, completionTokens: 5, cost: '0.03000000', errorCode: 'provider_error',
    }).where(eq(kbGenerationRuns.id, run.id));

    expect((await retryGenerationRun(db, agentId, run.id)).status).toBe('queued');
    const model = fakeModel();
    model.complete = async (input) => {
      model.calls.push(input);
      return { text: classified(), promptTokens: 11, completionTokens: 4, cost: '0.04000000' };
    };
    await executeGenerationRun({ db, model, credentialsKey: key }, run.id);

    expect(model.calls).toHaveLength(1);
    expect((await db.select().from(kbGenerationBatches).where(eq(kbGenerationBatches.id, firstBatch!.id)))[0])
      .toMatchObject({ status: 'done', attempts: 1, promptTokens: 5, completionTokens: 2, cost: '0.01000000' });
    expect((await db.select().from(kbGenerationBatches).where(eq(kbGenerationBatches.id, retryBatch!.id)))[0])
      .toMatchObject({ status: 'done', attempts: 2, promptTokens: 18, completionTokens: 7, cost: '0.06000000' });
    expect((await db.select().from(kbGenerationRuns).where(eq(kbGenerationRuns.id, run.id)))[0])
      .toMatchObject({ status: 'completed', promptTokens: 23, completionTokens: 9, cost: '0.07000000' });

    await db.update(kbGenerationBatches).set({ status: 'failed' }).where(eq(kbGenerationBatches.id, retryBatch!.id));
    await db.update(kbGenerationRuns).set({ status: 'failed' }).where(eq(kbGenerationRuns.id, run.id));
    await expect(retryGenerationRun(db, agentId, run.id)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('does not let an old applied proposal suppress knowledge that no longer exists', async () => {
    const first = await admitted('old');
    const [firstBatch] = await db.select().from(kbGenerationBatches).where(eq(kbGenerationBatches.runId, first.id));
    const body = 'Two days';
    const path = 'Delivery';
    const { createHash } = await import('node:crypto');
    const fingerprint = createHash('sha256').update(`${path.toLocaleLowerCase('ru')}\n${body.toLocaleLowerCase('ru')}`).digest('hex');
    await db.insert(kbGenerationProposals).values({ runId: first.id, batchId: firstBatch!.id, fingerprint, path, body, sources: [], status: 'applied' });
    await db.update(kbGenerationRuns).set({ status: 'completed' }).where(eq(kbGenerationRuns.id, first.id));
    const second = await admitted('new');
    const model = fakeModel(classified([{ path, body, sources: [messageId], warnings: [] }]));

    await executeGenerationRun({ db, model, credentialsKey: key }, second.id);

    expect(await db.select().from(kbGenerationProposals).where(eq(kbGenerationProposals.runId, second.id))).toHaveLength(1);
  });

  it('finishes a successful run with categorized review drafts without applying them', async () => {
    const run = await admitted('categorized-drafts');
    const model = fakeModel(classified([
      { path: 'База знаний/Доставка', body: 'Доставка занимает два дня.', sources: [messageId], warnings: [] },
      { path: 'Скрипт/Срок доставки', body: 'Сообщите срок и уточните адрес.', sources: [messageId], warnings: [] },
    ]));

    await executeGenerationRun({ db, model, credentialsKey: key }, run.id);

    expect(await db.select().from(kbDrafts)).toHaveLength(2);
    expect(await db.select().from(kbGenerationProposals).where(eq(kbGenerationProposals.runId, run.id)))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ path: 'База знаний/Доставка', status: 'drafted', draftOpIndex: 0, noteId: null }),
        expect.objectContaining({ path: 'Скрипт/Срок доставки', status: 'drafted', draftOpIndex: 0, noteId: null }),
      ]));
    expect((await db.select().from(kbGenerationRuns).where(eq(kbGenerationRuns.id, run.id)))[0]?.status).toBe('completed');
  });

  it('persists classification and excludes proposals from an irrelevant batch', async () => {
    const run = await admitted('irrelevant-classification');
    const reason = 'The conversation is with a supplier, not a customer.';
    const model = fakeModel(classified([
      { path: 'База знаний/Доставка', body: 'Два дня.', sources: [messageId], warnings: [] },
    ], 'irrelevant', reason));

    await executeGenerationRun({ db, model, credentialsKey: key }, run.id);

    expect((await db.select().from(kbGenerationBatches).where(eq(kbGenerationBatches.runId, run.id)))[0])
      .toMatchObject({ status: 'done', classification: 'irrelevant', classificationReason: reason });
    expect(await db.select().from(kbGenerationProposals).where(eq(kbGenerationProposals.runId, run.id))).toHaveLength(0);
  });
});
