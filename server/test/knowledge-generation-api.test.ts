import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import {
  agents,
  contacts,
  conversations,
  kbDrafts,
  kbGenerationBatches,
  kbGenerationDrafts,
  kbGenerationProposals,
  kbGenerationRawFindings,
  kbGenerationRuns,
  messages,
  whatsappNumbers,
} from '../src/db/schema.js';
import { keyAad } from '../src/lib/ai/turn.js';
import { encryptSecret } from '../src/lib/secret-box.js';
import { createAccountWithOwner } from '../src/lib/provision.js';
import { withDb } from './helpers/db.js';
import { testEnv } from './helpers/env.js';
import { fakeGraph } from './helpers/fake-graph.js';
import { fakeModel } from './helpers/fake-model.js';

const PASSWORD = 'correct-horse-battery';
const env = testEnv();
let db: Awaited<ReturnType<typeof withDb>>;
let app: FastifyInstance;
let agentId: string;
let conversationId: string;
let messageId: string;
let jar: Record<string, string>;
let model: ReturnType<typeof fakeModel>;

beforeEach(async () => {
  db = await withDb();
  const seeded = await createAccountWithOwner(db, { company: 'Generation', email: 'generation-api@example.test', name: 'Owner', initials: 'OW', password: PASSWORD });
  const [agent] = await db.insert(agents).values({ accountId: seeded.accountId, name: 'Agent' }).returning();
  agentId = agent!.id;
  await db.update(agents).set({ openrouterKey: encryptSecret('provider-key', Buffer.alloc(32, 7), keyAad(agentId)) }).where(eq(agents.id, agentId));
  const [number] = await db.insert(whatsappNumbers).values({ agentId, phoneNumberId: 'api-number', wabaId: 'waba', displayPhone: '+7', accessToken: 'x' }).returning();
  const [contact] = await db.insert(contacts).values({ agentId, phone: '77000000004' }).returning();
  const [conversation] = await db.insert(conversations).values({ agentId, contactId: contact!.id, whatsappNumberId: number!.id }).returning();
  conversationId = conversation!.id;
  await db.insert(messages).values({ conversationId, direction: 'in', author: 'client', kind: 'text', body: 'How long does delivery take?', sentAt: new Date('2026-09-01T09:59:00Z') });
  const [message] = await db.insert(messages).values({ conversationId, direction: 'out', author: 'operator', kind: 'text', body: 'Delivery takes two days', sentAt: new Date('2026-09-01T10:00:00Z') }).returning();
  messageId = message!.id;
  model = fakeModel('{"classification":{"value":"customer","reason":"Customer asks about delivery."},"proposals":[]}');
  app = buildServer(env, db, { graph: fakeGraph(), model });
  await app.ready();
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'generation-api@example.test', password: PASSWORD } });
  const cookie = login.cookies[0]!;
  jar = { [cookie.name]: cookie.value };
});

afterEach(async () => app.close());

const consolidated = (items: unknown[]) => JSON.stringify({ items });

function useConsolidatingModel(proposals: { path: string; body: string }[]): void {
  model.complete = async (input) => {
    model.calls.push(input);
    if (model.calls.length === 1) {
      return {
        text: JSON.stringify({
          classification: { value: 'customer', reason: 'Customer asks about delivery.' },
          proposals: proposals.map((proposal) => ({ ...proposal, sources: [messageId], warnings: [] })),
        }),
        promptTokens: 10,
        completionTokens: 4,
        cost: '0.00100000',
      };
    }
    const payload = JSON.parse(input.messages[1]!.content) as {
      proposals: { id: string; path: string; body: string }[];
    };
    return {
      text: consolidated(payload.proposals.map((proposal) => ({
        path: proposal.path,
        body: proposal.body,
        confidence: 'high',
        sourceProposalIds: [proposal.id],
      }))),
      promptTokens: 10,
      completionTokens: 4,
      cost: '0.00100000',
    };
  };
}

describe('knowledge generation API', () => {
  it('hides legacy raw proposal rows from reads and mutation routes', async () => {
    const [run] = await db.insert(kbGenerationRuns).values({
      agentId,
      requestedPreviewId: crypto.randomUUID(),
      requestKey: 'legacy-raw-defense',
      selection: { conversationIds: [], from: '2026-09-01T00:00:00Z', to: '2026-09-02T00:00:00Z' },
      manifest: { messages: [], batches: [] },
      counts: {
        selectedConversations: 0,
        selectedMessages: 0,
        eligibleMessages: 0,
        eligibleCharacters: 0,
        skippedAiOrSystem: 0,
        skippedUnsupported: 0,
        skippedEmpty: 0,
        skippedSensitive: 0,
        skippedOversize: 0,
        skippedNoSeller: 0,
      },
      modelId: 'model',
      temperature: '0.30',
      status: 'completed',
    }).returning();
    const [batch] = await db.insert(kbGenerationBatches).values({
      runId: run!.id,
      ordinal: 0,
      manifest: { ordinal: 0, conversationId, messages: [], characterCount: 0 },
      status: 'done',
    }).returning();
    const [legacyRaw] = await db.insert(kbGenerationProposals).values({
      runId: run!.id,
      batchId: batch!.id,
      fingerprint: 'raw:legacy:0:hash',
      path: 'База знаний/Legacy raw',
      body: 'Immutable evidence.',
      sources: [],
      status: 'rejected',
    }).returning();
    const base = `/api/agents/${agentId}/knowledge/generation`;

    const detail = await app.inject({ method: 'GET', url: `${base}/runs/${run!.id}`, cookies: jar });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().proposals.items).toEqual([]);
    expect(detail.json().run.proposalCount).toBe(0);
    expect((await app.inject({
      method: 'PATCH', url: `${base}/proposals/${legacyRaw!.id}`, cookies: jar,
      payload: { revision: 1, status: 'pending' },
    })).statusCode).toBe(409);
    expect((await app.inject({
      method: 'POST', url: `${base}/runs/${run!.id}/draft`, cookies: jar,
      payload: { proposalIds: [legacyRaw!.id], revisions: { [legacyRaw!.id]: 1 } },
    })).statusCode).toBe(404);
  });

  it('previews without a model call and starts asynchronously', async () => {
    const base = `/api/agents/${agentId}/knowledge/generation`;
    const preview = await app.inject({
      method: 'POST', url: `${base}/preview`, cookies: jar,
      payload: { conversationIds: [conversationId], from: '2026-09-01T00:00:00.000Z', to: '2026-09-02T00:00:00.000Z' },
    });
    expect(preview.statusCode).toBe(200);
    expect(model.calls).toHaveLength(0);

    const started = await app.inject({ method: 'POST', url: `${base}/runs`, cookies: jar, payload: { previewId: preview.json().previewId, requestKey: 'browser-request' } });
    expect(started.statusCode).toBe(202);
    expect(started.json().id).toBeTruthy();
    let detail;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      detail = await app.inject({ method: 'GET', url: `${base}/runs/${started.json().id}`, cookies: jar });
      if (detail.json().run.status !== 'queued' && detail.json().run.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(detail!.json().run.status).toBe('completed');
  });

  it('returns generated proposals for explicit review and draft conversion', async () => {
    useConsolidatingModel([{ path: 'База знаний/Доставка', body: 'Доставка занимает два дня.' }]);
    const base = `/api/agents/${agentId}/knowledge/generation`;
    const preview = await app.inject({ method: 'POST', url: `${base}/preview`, cookies: jar, payload: {
      conversationIds: [conversationId], from: '2026-09-01T00:00:00.000Z', to: '2026-09-02T00:00:00.000Z',
    } });
    const started = await app.inject({ method: 'POST', url: `${base}/runs`, cookies: jar, payload: { previewId: preview.json().previewId, requestKey: 'review-flow' } });
    let detail;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      detail = await app.inject({ method: 'GET', url: `${base}/runs/${started.json().id}`, cookies: jar });
      if (detail.json().run.status === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const proposal = detail!.json().proposals.items[0];
    expect(detail!.json().proposals.items).toHaveLength(1);
    expect(proposal.sources[0]).toMatchObject({ messageId, available: true });

    const [rawFinding] = await db.select().from(kbGenerationRawFindings);
    expect(rawFinding).toBeTruthy();
    expect((await app.inject({
      method: 'PATCH', url: `${base}/proposals/${rawFinding!.id}`, cookies: jar,
      payload: { revision: 1, body: 'Mutated raw finding' },
    })).statusCode).toBe(409);
    expect((await app.inject({
      method: 'POST', url: `${base}/runs/${started.json().id}/draft`, cookies: jar,
      payload: { proposalIds: [rawFinding!.id], revisions: { [rawFinding!.id]: 1 } },
    })).statusCode).toBe(404);

    expect(proposal).toMatchObject({ kind: 'knowledge', confidence: 'high', selected: true });
    const edited = await app.inject({ method: 'PATCH', url: `${base}/proposals/${proposal.id}`, cookies: jar, payload: { revision: proposal.revision, body: 'Доставка занимает два рабочих дня.', selected: true } });
    expect(edited.statusCode).toBe(200);
    const draft = await app.inject({ method: 'POST', url: `${base}/runs/${started.json().id}/draft`, cookies: jar, payload: {
      proposalIds: [proposal.id], revisions: { [proposal.id]: edited.json().revision },
    } });
    expect(draft.statusCode).toBe(200);
    expect(draft.json().draftId).toBeTruthy();
  });

  it('creates no automatic drafts and returns an explicit draft independently of proposal pagination', async () => {
    useConsolidatingModel([
      { path: 'База знаний/Доставка', body: 'Доставка занимает два дня.' },
      { path: 'Скрипт/Доставка', body: 'Доставка займёт два дня. Подскажите, пожалуйста, адрес.' },
    ]);
    const base = `/api/agents/${agentId}/knowledge/generation`;
    const preview = await app.inject({ method: 'POST', url: `${base}/preview`, cookies: jar, payload: {
      conversationIds: [conversationId], from: '2026-09-01T00:00:00.000Z', to: '2026-09-02T00:00:00.000Z',
    } });
    const started = await app.inject({ method: 'POST', url: `${base}/runs`, cookies: jar, payload: {
      previewId: preview.json().previewId, requestKey: 'all-generated-drafts',
    } });
    let detail;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      detail = await app.inject({ method: 'GET', url: `${base}/runs/${started.json().id}`, cookies: jar });
      if (detail.json().run.status === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(detail!.json().proposals.items).toHaveLength(2);
    expect(detail!.json().drafts).toEqual([]);
    expect(detail!.json().draftsNextCursor).toBeNull();
    const items = detail!.json().proposals.items as { id: string; revision: number }[];
    const explicit = await app.inject({
      method: 'POST', url: `${base}/runs/${started.json().id}/draft`, cookies: jar,
      payload: {
        proposalIds: items.map((item) => item.id),
        revisions: Object.fromEntries(items.map((item) => [item.id, item.revision])),
      },
    });
    expect(explicit.statusCode).toBe(200);

    const paged = await app.inject({
      method: 'GET', url: `${base}/runs/${started.json().id}?cursor=20`, cookies: jar,
    });
    expect(paged.json().proposals.items).toEqual([]);
    expect(paged.json().drafts).toEqual([
      expect.objectContaining({ id: explicit.json().draftId, title: 'Знания из WhatsApp · 2' }),
    ]);
    expect(paged.json().draftsNextCursor).toBeNull();
  });

  it('paginates run history and includes complete draft, classification, usage, and error summaries', async () => {
    const selection = { conversationIds: [], from: '2026-09-01T00:00:00Z', to: '2026-09-02T00:00:00Z' };
    const counts = {
      selectedConversations: 0,
      selectedMessages: 0,
      eligibleMessages: 0,
      eligibleCharacters: 0,
      skippedAiOrSystem: 0,
      skippedUnsupported: 0,
      skippedEmpty: 0,
      skippedSensitive: 0,
      skippedOversize: 0,
      skippedNoSeller: 0,
    };
    const runs = await db.insert(kbGenerationRuns).values(Array.from({ length: 21 }, (_, index) => ({
      agentId,
      requestedPreviewId: crypto.randomUUID(),
      requestKey: `history-${index}`,
      selection,
      manifest: { messages: [], batches: [] },
      counts,
      modelId: 'history-model',
      temperature: '0.30',
      status: 'completed',
      promptTokens: 12,
      completionTokens: 4,
      cost: '0.12500000',
      createdAt: new Date(Date.UTC(2026, 8, 1, 0, index)),
    }))).returning();
    const newest = runs.at(-1)!;
    const [batch] = await db.insert(kbGenerationBatches).values({
      runId: newest.id,
      ordinal: 0,
      manifest: { ordinal: 0, conversationId, messages: [], characterCount: 0 },
      classification: 'irrelevant',
      classificationReason: 'Это внутренний разговор.',
      status: 'failed',
      errorCode: 'malformed_output',
    }).returning();
    const [draft] = await db.insert(kbDrafts).values({
      agentId,
      title: 'Исторический черновик',
      origin: 'manual',
      ops: [],
      base: {},
    }).returning();
    await db.insert(kbGenerationDrafts).values({ runId: newest.id, draftId: draft!.id });

    const first = await app.inject({
      method: 'GET',
      url: `/api/agents/${agentId}/knowledge/generation/runs`,
      cookies: jar,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().items).toHaveLength(20);
    expect(first.json().nextCursor).toBe('20');
    expect(first.json().items[0]).toMatchObject({
      id: newest.id,
      classificationCounts: { customer: 0, irrelevant: 1, uncertain: 0 },
      excludedBatchCount: 1,
      usage: { promptTokens: 12, completionTokens: 4, cost: '0.12500000' },
      errors: [{ batchId: batch!.id, ordinal: 0, code: 'malformed_output' }],
      drafts: [expect.objectContaining({ id: draft!.id, title: 'Исторический черновик', status: 'open' })],
      draftsNextCursor: null,
    });
    const second = await app.inject({
      method: 'GET',
      url: `/api/agents/${agentId}/knowledge/generation/runs?cursor=20`,
      cookies: jar,
    });
    expect(second.json()).toMatchObject({ items: [expect.any(Object)], nextCursor: null });
  });

  it('returns exclusions and optional immutable raw findings, normalizing historical classifications only in the response', async () => {
    const [run] = await db.insert(kbGenerationRuns).values({
      agentId,
      requestedPreviewId: crypto.randomUUID(),
      requestKey: 'auditable-detail',
      selection: { conversationIds: [], from: '2026-09-01T00:00:00Z', to: '2026-09-02T00:00:00Z' },
      manifest: { messages: [], batches: [] },
      counts: {
        selectedConversations: 0,
        selectedMessages: 0,
        eligibleMessages: 0,
        eligibleCharacters: 0,
        skippedAiOrSystem: 0,
        skippedUnsupported: 0,
        skippedEmpty: 0,
        skippedSensitive: 0,
        skippedOversize: 0,
        skippedNoSeller: 0,
      },
      modelId: 'model',
      temperature: '0.30',
      status: 'completed',
    }).returning();
    const [historical, , , irrelevant] = await db.insert(kbGenerationBatches).values([
      {
        runId: run!.id,
        ordinal: 0,
        manifest: { ordinal: 0, conversationId, messages: [], characterCount: 0 },
        status: 'done',
      },
      {
        runId: run!.id,
        ordinal: 2,
        manifest: { ordinal: 2, conversationId, messages: [], characterCount: 0 },
        status: 'failed',
        errorCode: 'provider_error',
      },
      {
        runId: run!.id,
        ordinal: 3,
        manifest: { ordinal: 3, conversationId, messages: [], characterCount: 0 },
        status: 'cancelled',
      },
      {
        runId: run!.id,
        ordinal: 1,
        manifest: { ordinal: 1, conversationId, messages: [], characterCount: 0 },
        classification: 'irrelevant',
        classificationReason: 'Это разговор с поставщиком.',
        status: 'done',
      },
    ]).returning();
    const [raw] = await db.insert(kbGenerationRawFindings).values({
      runId: run!.id,
      batchId: irrelevant!.id,
      fingerprint: 'audit-finding',
      path: 'База знаний/Аудит',
      body: 'Исходная находка.',
      warnings: ['context_limited'],
      sources: [],
    }).returning();
    const [historicalDraft] = await db.insert(kbDrafts).values({
      agentId,
      title: 'Черновик до связи запусков',
      origin: 'manual',
      ops: [],
      base: {},
    }).returning();
    await db.insert(kbGenerationProposals).values({
      runId: run!.id,
      batchId: historical!.id,
      fingerprint: 'historical-draft-proposal',
      path: 'База знаний/История',
      body: 'Старое предложение.',
      sources: [],
      status: 'drafted',
      draftId: historicalDraft!.id,
      draftOpIndex: 0,
    });
    await db.insert(kbGenerationDrafts).values({ runId: run!.id, draftId: historicalDraft!.id });

    const base = `/api/agents/${agentId}/knowledge/generation/runs/${run!.id}`;
    const withoutRaw = await app.inject({ method: 'GET', url: base, cookies: jar });
    expect(withoutRaw.statusCode).toBe(200);
    expect(withoutRaw.json()).not.toHaveProperty('rawFindings');
    expect(withoutRaw.json().exclusions).toEqual([
      { batchId: historical!.id, ordinal: 0, classification: 'uncertain', reason: 'Более ранний запуск' },
      { batchId: irrelevant!.id, ordinal: 1, classification: 'irrelevant', reason: 'Это разговор с поставщиком.' },
    ]);
    expect(withoutRaw.json().exclusionsNextCursor).toBeNull();
    expect(withoutRaw.json().run.classificationCounts).toEqual({ customer: 0, irrelevant: 1, uncertain: 1 });
    expect(withoutRaw.json().drafts).toEqual([
      expect.objectContaining({ id: historicalDraft!.id, title: 'Черновик до связи запусков' }),
    ]);
    expect(withoutRaw.json().draftsNextCursor).toBeNull();

    const withRaw = await app.inject({ method: 'GET', url: `${base}?includeRawFindings=true`, cookies: jar });
    expect(withRaw.json().rawFindings).toEqual([
      expect.objectContaining({ id: raw!.id, path: 'База знаний/Аудит', body: 'Исходная находка.', warnings: ['context_limited'] }),
    ]);
    expect(withRaw.json().rawFindingsNextCursor).toBeNull();
    const [storedHistorical] = await db.select().from(kbGenerationBatches).where(eq(kbGenerationBatches.id, historical!.id));
    expect(storedHistorical).toMatchObject({ classification: null, classificationReason: null });
  });

  it('persists checked state revision-safely and drafts only the complete checked set', async () => {
    useConsolidatingModel([{ path: 'База знаний/Доставка', body: 'Доставка занимает два дня.' }]);
    const base = `/api/agents/${agentId}/knowledge/generation`;
    const preview = await app.inject({ method: 'POST', url: `${base}/preview`, cookies: jar, payload: {
      conversationIds: [conversationId], from: '2026-09-01T00:00:00.000Z', to: '2026-09-02T00:00:00.000Z',
    } });
    const started = await app.inject({ method: 'POST', url: `${base}/runs`, cookies: jar, payload: {
      previewId: preview.json().previewId, requestKey: 'persist-selection',
    } });
    let detail;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      detail = await app.inject({ method: 'GET', url: `${base}/runs/${started.json().id}`, cookies: jar });
      if (detail.json().run.status === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const proposal = detail!.json().proposals.items[0];
    const selected = await app.inject({
      method: 'PATCH',
      url: `${base}/proposals/${proposal.id}`,
      cookies: jar,
      payload: { revision: proposal.revision, selected: true },
    });
    expect(selected.statusCode).toBe(200);
    expect(selected.json()).toMatchObject({ selected: true, revision: proposal.revision + 1 });
    const stale = await app.inject({
      method: 'PATCH',
      url: `${base}/proposals/${proposal.id}`,
      cookies: jar,
      payload: { revision: proposal.revision, selected: false },
    });
    expect(stale.statusCode).toBe(409);

    const draft = await app.inject({
      method: 'POST',
      url: `${base}/runs/${started.json().id}/draft`,
      cookies: jar,
      payload: { proposalIds: [proposal.id], revisions: { [proposal.id]: selected.json().revision } },
    });
    expect(draft.statusCode).toBe(200);
    expect(await db.select().from(kbGenerationDrafts)).toEqual([
      expect.objectContaining({ runId: started.json().id, draftId: draft.json().draftId }),
    ]);
  });

  it('bounds proposals, drafts, exclusions, and raw findings with independent cursors', async () => {
    const [run] = await db.insert(kbGenerationRuns).values({
      agentId,
      requestedPreviewId: crypto.randomUUID(),
      requestKey: 'bounded-detail',
      selection: { conversationIds: [], from: '2026-09-01T00:00:00Z', to: '2026-09-02T00:00:00Z' },
      manifest: { messages: [], batches: [] },
      counts: {
        selectedConversations: 0, selectedMessages: 0, eligibleMessages: 0, eligibleCharacters: 0,
        skippedAiOrSystem: 0, skippedUnsupported: 0, skippedEmpty: 0, skippedSensitive: 0,
        skippedOversize: 0, skippedNoSeller: 0,
      },
      modelId: 'model',
      temperature: '0.30',
      status: 'completed',
    }).returning();
    const batches = await db.insert(kbGenerationBatches).values(Array.from({ length: 21 }, (_, ordinal) => ({
      runId: run!.id,
      ordinal,
      manifest: { ordinal, conversationId, messages: [], characterCount: 0 },
      classification: 'irrelevant' as const,
      classificationReason: `Причина ${ordinal}`,
      status: 'done',
    }))).returning();
    await db.insert(kbGenerationProposals).values(batches.map((batch, index) => ({
      runId: run!.id,
      batchId: batch.id,
      fingerprint: `bounded-proposal-${index}`,
      path: `База знаний/${index}`,
      body: `Предложение ${index}`,
      sources: [],
      createdAt: new Date(Date.UTC(2026, 8, 1, 0, index)),
    })));
    await db.insert(kbGenerationRawFindings).values(batches.map((batch, index) => ({
      runId: run!.id,
      batchId: batch.id,
      fingerprint: `bounded-raw-${index}`,
      path: `База знаний/Исходное ${index}`,
      body: `Находка ${index}`,
      sources: [],
      createdAt: new Date(Date.UTC(2026, 8, 1, 0, index)),
    })));
    const drafts = await db.insert(kbDrafts).values(Array.from({ length: 21 }, (_, index) => ({
      agentId,
      title: `Черновик ${index}`,
      origin: 'manual',
      ops: [],
      base: {},
      createdAt: new Date(Date.UTC(2026, 8, 1, 0, index)),
    }))).returning();
    await db.insert(kbGenerationDrafts).values(drafts.map((draft) => ({ runId: run!.id, draftId: draft.id })));

    const base = `/api/agents/${agentId}/knowledge/generation/runs/${run!.id}`;
    const first = await app.inject({ method: 'GET', url: `${base}?includeRawFindings=true`, cookies: jar });
    expect(first.statusCode).toBe(200);
    expect(first.json().proposals).toMatchObject({ items: expect.any(Array), nextCursor: '20' });
    expect(first.json().proposals.items).toHaveLength(20);
    expect(first.json().drafts).toHaveLength(20);
    expect(first.json().draftsNextCursor).toBe('20');
    expect(first.json().run.drafts).toHaveLength(20);
    expect(first.json().run.draftsNextCursor).toBe('20');
    expect(first.json().exclusions).toHaveLength(20);
    expect(first.json().exclusionsNextCursor).toBe('20');
    expect(first.json().rawFindings).toHaveLength(20);
    expect(first.json().rawFindingsNextCursor).toBe('20');

    const second = await app.inject({
      method: 'GET',
      url: `${base}?proposalCursor=20&draftCursor=20&exclusionCursor=20&rawFindingCursor=20&includeRawFindings=true`,
      cookies: jar,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().proposals).toMatchObject({ items: [expect.any(Object)], nextCursor: null });
    expect(second.json()).toMatchObject({
      drafts: [expect.any(Object)], draftsNextCursor: null,
      exclusions: [expect.any(Object)], exclusionsNextCursor: null,
      rawFindings: [expect.any(Object)], rawFindingsNextCursor: null,
    });
  });
});
