import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { agents, contacts, conversations, kbDrafts, kbGenerationBatches, kbGenerationProposals, kbGenerationRawFindings, kbGenerationRuns, kbNotes, messages, users, whatsappNumbers, accounts } from '../src/db/schema.js';
import type { CompletionInput } from '../src/lib/ai/openrouter.js';
import { keyAad } from '../src/lib/ai/turn.js';
import { GENERATION_CONSOLIDATION_MODEL, SEED_TOPICS } from '../src/lib/knowledge/generation-consolidate.js';
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
let customerMessageId: string;
const key = Buffer.alloc(32, 7);
const classified = (
  proposals: unknown[] = [],
  classification: 'customer' | 'irrelevant' | 'uncertain' = 'customer',
  reason = 'The client asks about delivery and the seller answers.',
) => JSON.stringify({
  classification: {
    value: classification,
    reason,
    evidence: classification === 'customer' ? [
      { messageId: customerMessageId, quote: 'How long does delivery take?' },
      { messageId, quote: 'Delivery takes two days' },
    ] : [],
  },
  proposals,
});

/**
 * Answers a consolidation call like the two topic prompts: the assign step files each finding
 * under its own path's title (legacy «Скрипт/» findings included), and a write call returns the
 * first finding's body as a well-formed note (a heading, a link when anything is linkable).
 */
const consolidationAnswer = (call: CompletionInput): string => {
  const payload = JSON.parse(call.messages[1]!.content) as {
    proposals?: { id: string; path: string }[];
    findings?: { body: string }[];
    linkableTopics?: string[];
  };
  if (payload.proposals) {
    return JSON.stringify({ assignments: payload.proposals.map((proposal) => ({
      id: proposal.id, topic: proposal.path.slice(proposal.path.lastIndexOf('/') + 1),
    })) });
  }
  const link = payload.linkableTopics?.[0];
  return JSON.stringify({ body: `${noteBody(payload.findings![0]!.body)}${link ? `\n\nСвязано: [[${link}]]` : ''}`, confidence: 'high' });
};

const noteBody = (fact: string): string => `## Факты\n- ${fact}`;

const consolidationModel = (extraction: string) => {
  const model = fakeModel();
  model.complete = async (call) => {
    model.calls.push(call);
    const text = model.calls.length === 1 ? extraction : consolidationAnswer(call);
    return { text, promptTokens: 100, completionTokens: 20, cost: '0.00010000' };
  };
  return model;
};

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
  const [customerMessage] = await db.insert(messages).values({ conversationId, direction: 'in', author: 'client', kind: 'text', body: 'How long does delivery take?', sentAt: new Date('2026-09-01T09:59:00Z') }).returning();
  customerMessageId = customerMessage!.id;
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
    const path = 'База знаний/Доставка';
    const { createHash } = await import('node:crypto');
    const fingerprint = createHash('sha256').update(`${path.toLocaleLowerCase('ru')}\n${body.toLocaleLowerCase('ru')}`).digest('hex');
    await db.insert(kbGenerationProposals).values({ runId: first.id, batchId: firstBatch!.id, fingerprint, path, body, sources: [], status: 'applied' });
    await db.update(kbGenerationRuns).set({ status: 'completed' }).where(eq(kbGenerationRuns.id, first.id));
    const second = await admitted('new');
    const model = consolidationModel(classified([{ path, body, sources: [messageId], warnings: [] }]));

    await executeGenerationRun({ db, model, credentialsKey: key }, second.id);

    expect(await db.select().from(kbGenerationProposals).where(eq(kbGenerationProposals.runId, second.id)))
      .toHaveLength(1);
  });

  it('finishes with consolidated review items without automatically creating category drafts', async () => {
    const run = await admitted('categorized-drafts');
    const model = consolidationModel(classified([
      { path: 'База знаний/Доставка', body: 'Доставка занимает два дня.', sources: [messageId], warnings: [] },
      { path: 'Скрипт/Срок доставки', body: 'Доставка займёт два дня. Подскажите, пожалуйста, адрес.', sources: [messageId], warnings: [] },
    ]));

    await executeGenerationRun({ db, model, credentialsKey: key }, run.id);

    expect(await db.select().from(kbDrafts)).toHaveLength(0);
    const proposals = await db.select().from(kbGenerationProposals).where(eq(kbGenerationProposals.runId, run.id));
    expect(proposals).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'knowledge', path: 'База знаний/Доставка', confidence: 'high', selected: true, status: 'pending', draftId: null }),
        expect.objectContaining({ kind: 'knowledge', path: 'База знаний/Срок доставки', confidence: 'high', selected: true, status: 'pending', draftId: null }),
      ]));
    expect(proposals).toHaveLength(2);
    expect(await db.select().from(kbGenerationRawFindings).where(eq(kbGenerationRawFindings.runId, run.id)))
      .toHaveLength(2);
    // Extraction, one assign call and one write call per topic.
    expect(model.calls).toHaveLength(4);
    expect((await db.select().from(kbGenerationRuns).where(eq(kbGenerationRuns.id, run.id)))[0])
      .toMatchObject({ status: 'completed', promptTokens: 400, completionTokens: 80, cost: '0.00040000' });
  });

  it('tells consolidation about knowledge-base topics and the open chat draft', async () => {
    const run = await admitted('existing-topics');
    await db.insert(kbNotes).values([
      { agentId, path: 'База знаний/Оплата', title: 'Оплата', body: 'Kaspi.' },
      { agentId, path: 'Инструкции/Тон', title: 'Тон', body: 'Вежливо.' },
    ]);
    await db.insert(kbDrafts).values({
      agentId, title: 'Скрипт продаж из WhatsApp · 3', origin: 'manual', base: {},
      ops: [{ op: 'note_create', path: 'База знаний/Сроки', body: 'Два дня.' }],
    });
    const model = consolidationModel(classified([
      { path: 'База знаний/Сроки', body: 'Доставка занимает два дня.', sources: [messageId], warnings: [] },
    ]));

    await executeGenerationRun({ db, model, credentialsKey: key }, run.id);

    const assign = JSON.parse(model.calls[1]!.messages[1]!.content) as { topics: string[] };
    expect(assign.topics).toEqual(['Оплата', 'Сроки', ...SEED_TOPICS.filter((seed) => seed !== 'Оплата')]);
    const write = JSON.parse(model.calls[2]!.messages[1]!.content) as { topic: string; existingBody?: string };
    expect(write).toEqual(expect.objectContaining({ topic: 'Сроки', existingBody: 'Два дня.' }));
  });

  it('keeps grounded raw findings and reports an honest error when consolidation fails', async () => {
    const run = await admitted('consolidation-failure');
    const model = fakeModel(
      classified([{ path: 'База знаний/Доставка', body: 'Доставка занимает два дня.', sources: [messageId], warnings: [] }]),
      new Error('provider unavailable'),
    );

    await executeGenerationRun({ db, model, credentialsKey: key }, run.id);

    expect(await db.select().from(kbGenerationProposals).where(eq(kbGenerationProposals.runId, run.id)))
      .toEqual([]);
    expect(await db.select().from(kbGenerationRawFindings).where(eq(kbGenerationRawFindings.runId, run.id))).toEqual([
      expect.objectContaining({
        path: 'База знаний/Доставка',
        body: 'Доставка занимает два дня.',
      }),
    ]);
    expect(await db.select().from(kbDrafts)).toHaveLength(0);
    expect((await db.select().from(kbGenerationRuns).where(eq(kbGenerationRuns.id, run.id)))[0])
      .toMatchObject({ status: 'failed', errorCode: 'consolidation_failed', promptTokens: 100, completionTokens: 20 });
  });

  it('retries consolidation from saved raw findings without buying extraction again', async () => {
    const run = await admitted('consolidation-retry');
    const extraction = classified([
      { path: 'База знаний/Доставка', body: 'Доставка занимает два дня.', sources: [messageId], warnings: [] },
    ]);
    await executeGenerationRun({
      db,
      model: fakeModel(extraction, new Error('provider unavailable')),
      credentialsKey: key,
    }, run.id);

    await expect(retryGenerationRun(db, agentId, run.id)).resolves.toMatchObject({ status: 'queued' });
    const model = fakeModel();
    model.complete = async (call) => {
      model.calls.push(call);
      return {
        text: consolidationAnswer(call),
        promptTokens: 50,
        completionTokens: 10,
        cost: '0.00005000',
      };
    };

    await executeGenerationRun({ db, model, credentialsKey: key }, run.id);

    expect(model.calls).toHaveLength(2);
    expect((await db.select().from(kbGenerationBatches).where(eq(kbGenerationBatches.runId, run.id)))[0])
      .toMatchObject({ status: 'done', attempts: 1, promptTokens: 100, completionTokens: 20 });
    expect((await db.select().from(kbGenerationRuns).where(eq(kbGenerationRuns.id, run.id)))[0])
      .toMatchObject({ status: 'completed', promptTokens: 200, completionTokens: 40, cost: '0.00020000' });
    expect(await db.select().from(kbGenerationProposals).where(eq(kbGenerationProposals.runId, run.id)))
      .toEqual([expect.objectContaining({ path: 'База знаний/Доставка', body: noteBody('Доставка занимает два дня.') })]);
  });

  it('resumes only consolidation after an interruption that followed persisted extraction', async () => {
    const run = await admitted('post-extraction-interruption');
    const [batch] = await db.select().from(kbGenerationBatches).where(eq(kbGenerationBatches.runId, run.id));
    await db.update(kbGenerationBatches).set({
      status: 'done', attempts: 1, promptTokens: 80, completionTokens: 12, cost: '0.00008000',
    }).where(eq(kbGenerationBatches.id, batch!.id));
    await db.insert(kbGenerationRawFindings).values({
      runId: run.id,
      batchId: batch!.id,
      fingerprint: 'post-extraction-finding',
      path: 'База знаний/Доставка',
      body: 'Доставка занимает два дня.',
      warnings: [],
      sources: [{ conversationId, messageId, sentAt: '2026-09-01T10:00:00.000Z' }],
    });
    await db.update(kbGenerationRuns).set({
      status: 'running', promptTokens: 80, completionTokens: 12, cost: '0.00008000',
    }).where(eq(kbGenerationRuns.id, run.id));
    await reconcileGenerationRuns(db);

    await expect(retryGenerationRun(db, agentId, run.id)).resolves.toMatchObject({ status: 'queued' });
    const model = fakeModel();
    model.complete = async (call) => {
      model.calls.push(call);
      return {
        text: consolidationAnswer(call),
        promptTokens: 40,
        completionTokens: 8,
        cost: '0.00004000',
      };
    };

    await executeGenerationRun({ db, model, credentialsKey: key }, run.id);

    expect(model.calls).toHaveLength(2);
    expect((await db.select().from(kbGenerationRuns).where(eq(kbGenerationRuns.id, run.id)))[0])
      .toMatchObject({ status: 'completed', promptTokens: 160, completionTokens: 28, cost: '0.00016000' });
  });

  it('extracts on the run model, consolidates on the fixed model, and keeps a link the seller sent in two chats', async () => {
    const link = 'https://2gis.kz/almaty/firm/70000001234567';
    const [secondContact] = await db.insert(contacts).values({ agentId, phone: '77000000004' }).returning();
    const [secondConversation] = await db.insert(conversations).values({
      agentId, contactId: secondContact!.id, whatsappNumberId: (await db.select().from(whatsappNumbers))[0]!.id,
    }).returning();
    await db.update(messages).set({ body: `Delivery takes two days. Мы здесь: ${link}` }).where(eq(messages.id, messageId));
    await db.insert(messages).values([
      { conversationId: secondConversation!.id, direction: 'in', author: 'client', kind: 'text', body: 'Where are you?', sentAt: new Date('2026-09-01T11:00:00Z') },
      { conversationId: secondConversation!.id, direction: 'out', author: 'operator', kind: 'text', body: `Мы здесь: ${link}`, sentAt: new Date('2026-09-01T11:01:00Z') },
    ]);
    const preview = await previewSelection(db, agentId, {
      conversationIds: [conversationId, secondConversation!.id], from: '2026-09-01T00:00:00Z', to: '2026-09-02T00:00:00Z',
    }, userId);
    const run = await startGenerationRun(db, agentId, userId, preview.previewId, 'business-contact');
    const model = fakeModel();
    model.complete = async (call) => {
      model.calls.push(call);
      const payload = JSON.parse(call.messages[1]!.content) as { messages?: { id: string }[] };
      const text = !payload.messages
        ? consolidationAnswer(call)
        : payload.messages.some((message) => message.id === messageId)
          ? classified([{ path: 'База знаний/Контакты и адрес', body: `Мы здесь: ${link}`, sources: [messageId], warnings: [] }])
          : JSON.stringify({ classification: { value: 'irrelevant', reason: 'Нет вопроса о покупке.' }, proposals: [] });
      return { text, promptTokens: 100, completionTokens: 20, cost: '0.00010000' };
    };

    await executeGenerationRun({ db, model, credentialsKey: key }, run.id);

    expect(model.calls.map((call) => call.model)).toEqual([
      run.modelId, run.modelId, GENERATION_CONSOLIDATION_MODEL, GENERATION_CONSOLIDATION_MODEL,
    ]);
    for (const extraction of model.calls.slice(0, 2)) {
      expect(JSON.parse(extraction.messages[1]!.content)).toMatchObject({ businessContacts: [link] });
    }
    expect(await db.select().from(kbGenerationProposals).where(eq(kbGenerationProposals.runId, run.id)))
      .toEqual([expect.objectContaining({ path: 'База знаний/Контакты и адрес', body: noteBody(`Мы здесь: ${link}`) })]);
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
