import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  accounts,
  agents,
  kbDrafts,
  kbGenerationBatches,
  kbGenerationDrafts,
  kbGenerationProposals,
  kbGenerationRuns,
  kbNotes,
  users,
} from '../src/db/schema.js';
import type { CompletionInput } from '../src/lib/ai/openrouter.js';
import { keyAad } from '../src/lib/ai/turn.js';
import { regroupWhatsAppDrafts } from '../src/lib/knowledge/whatsapp-regroup.js';
import { encryptSecret } from '../src/lib/secret-box.js';
import { withDb } from './helpers/db.js';
import { fakeModel } from './helpers/fake-model.js';

const key = Buffer.alloc(32, 9);

let db: Awaited<ReturnType<typeof withDb>>;
let agentId: string;
let runId: string;
let noteId: string;
let legacyScriptId: string;
let legacyKnowledgeId: string;
const proposal: Record<'terms' | 'price' | 'delivery' | 'payment', string> = { terms: '', price: '', delivery: '', payment: '' };

const source = (messageId: string) => ({ conversationId: 'c1', messageId, sentAt: '2026-09-01T10:00:00.000Z' });

beforeEach(async () => {
  db = await withDb();
  const [account] = await db.insert(accounts).values({ name: 'Regroup' }).returning();
  const [user] = await db.insert(users).values({ email: 'regroup@example.test', passwordHash: 'x', name: 'Owner', initials: 'OW' }).returning();
  const [agent] = await db.insert(agents).values({ accountId: account!.id, name: 'Agent', communicationStyle: 'friendly' }).returning();
  agentId = agent!.id;
  await db.update(agents).set({ openrouterKey: encryptSecret('provider-key', key, keyAad(agentId)) }).where(eq(agents.id, agentId));
  const selection = { conversationIds: [], from: '2026-09-01T00:00:00Z', to: '2026-09-02T00:00:00Z' };
  const counts = { selectedConversations: 0, selectedMessages: 0, eligibleMessages: 0, eligibleCharacters: 0, skippedAiOrSystem: 0, skippedUnsupported: 0, skippedEmpty: 0, skippedSensitive: 0, skippedOversize: 0, skippedNoSeller: 0 };
  const [run] = await db.insert(kbGenerationRuns).values({ agentId, userId: user!.id, requestedPreviewId: crypto.randomUUID(), requestKey: 'regroup', selection, manifest: { messages: [], batches: [] }, counts, modelId: 'run-model', temperature: '0.10', status: 'completed' }).returning();
  runId = run!.id;
  const [batch] = await db.insert(kbGenerationBatches).values({ runId, ordinal: 0, manifest: { ordinal: 0, conversationId: crypto.randomUUID(), messages: [], characterCount: 0 }, status: 'done' }).returning();
  const [note] = await db.insert(kbNotes).values({ agentId, path: 'База знаний/Оплата', title: 'Оплата', body: 'Kaspi.' }).returning();
  noteId = note!.id;

  const [script] = await db.insert(kbDrafts).values({
    agentId, title: 'Скрипт продаж из WhatsApp', origin: 'manual', base: {}, createdBy: user!.id, createdAt: new Date('2026-09-12T08:00:00Z'),
    ops: [
      { op: 'note_create', path: 'Скрипт/Сроки', body: 'Сделаем за три дня.' },
      { op: 'note_create', path: 'Скрипт/Баға', body: 'Бағасы 5000 теңге.' },
    ],
  }).returning();
  const [knowledge] = await db.insert(kbDrafts).values({
    agentId, title: 'База знаний из WhatsApp · 2', origin: 'manual', base: {}, createdBy: user!.id, createdAt: new Date('2026-09-12T09:00:00Z'),
    ops: [
      { op: 'note_create', path: 'База знаний/Сроки выполнения', body: 'Изготовление три дня.' },
      { op: 'note_create', path: 'База знаний/Оплата', body: 'Kaspi QR.' },
    ],
  }).returning();
  legacyScriptId = script!.id;
  legacyKnowledgeId = knowledge!.id;
  await db.insert(kbGenerationDrafts).values({ runId, draftId: knowledge!.id, requestKey: 'old' });
  const drafted = async (name: keyof typeof proposal, draftId: string, draftOpIndex: number, path: string) => {
    const [row] = await db.insert(kbGenerationProposals).values({
      runId, batchId: batch!.id, fingerprint: name, path, body: name, sources: [source(`m-${name}`)],
      status: 'drafted', draftId, draftOpIndex,
    }).returning();
    proposal[name] = row!.id;
  };
  await drafted('terms', script!.id, 0, 'Скрипт/Сроки');
  await drafted('price', script!.id, 1, 'Скрипт/Баға');
  await drafted('delivery', knowledge!.id, 0, 'База знаний/Сроки выполнения');
  await drafted('payment', knowledge!.id, 1, 'База знаний/Оплата');
});

const bodies: Record<string, string> = {
  'Сроки': 'Сроки изготовления.\n\n## Факты\n- Три дня.\n\n## Готовые фразы\n- «Сделаем за три дня.»\n\nСвязано: [[Оплата]]',
  'Оплата': 'Как оплатить.\n\n## Факты\n- Kaspi.\n- Kaspi QR.',
};

/** Answers like the two topic prompts: both «сроки» ops go to one topic, payment extends the note, price is dropped. */
const topicModel = (onCall?: () => Promise<void>) => {
  const model = fakeModel();
  model.complete = async (call: CompletionInput) => {
    model.calls.push(call);
    await onCall?.();
    const payload = JSON.parse(call.messages[1]!.content) as {
      proposals?: { id: string; path: string }[];
      topic?: string;
    };
    const text = payload.proposals
      ? JSON.stringify({ assignments: payload.proposals.map((raw) => ({
        id: raw.id,
        topic: raw.path.includes('Сроки') ? 'Сроки' : raw.path.endsWith('Оплата') ? 'оплата' : null,
      })) })
      : JSON.stringify({ body: bodies[payload.topic!], confidence: 'high' });
    return { text, promptTokens: 300, completionTokens: 90, cost: '0.00300000' };
  };
  return model;
};

describe('regroupWhatsAppDrafts', () => {
  it('prints topics on a dry run and writes nothing', async () => {
    const model = topicModel();
    const lines: string[] = [];

    const results = await regroupWhatsAppDrafts(db, { model, credentialsKey: key, log: (line) => lines.push(line) }, { dryRun: true });

    expect(results).toEqual([expect.objectContaining({
      agentId, outcome: 'dry_run', beforeOps: 4,
      topics: [{ path: 'База знаний/Сроки', ops: 2 }, { path: 'База знаний/Оплата', ops: 1 }],
    })]);
    // Only the assign step runs: one cheap call, no topic bodies written.
    expect(model.calls).toHaveLength(1);
    expect(lines[0]).toContain('4 ops → 2 topics');
    expect(lines[0]).toContain('300/90 tokens');
    expect(lines).toContain('  База знаний/Сроки ← 2 ops');
    expect(lines).toContain('  База знаний/Оплата ← 1 ops');
    expect(model.calls[0]).toMatchObject({ key: 'provider-key', model: 'run-model', temperature: '0.10' });
    const payload = JSON.parse(model.calls[0]!.messages[1]!.content) as { topics: string[]; proposals: unknown[] };
    expect(payload.topics).toContain('Оплата');
    expect(payload.proposals).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'Скрипт/Сроки', body: 'Сделаем за три дня.' }),
    ]));
    expect((await db.select().from(kbDrafts)).every((draft) => draft.status === 'open')).toBe(true);
    expect(await db.select().from(kbDrafts)).toHaveLength(2);
  });

  it('leaves one topic draft, repoints cited proposals and releases dropped ones', async () => {
    const model = topicModel();
    const lines: string[] = [];
    await regroupWhatsAppDrafts(db, { model, credentialsKey: key, log: (line) => lines.push(line) }, { dryRun: false });

    expect(model.calls).toHaveLength(3);
    const payment = JSON.parse(model.calls[2]!.messages[1]!.content) as { topic: string; existingBody?: string };
    expect(payment).toMatchObject({ topic: 'Оплата', existingBody: 'Kaspi.' });
    expect(lines[0]).toContain('900/270 tokens');
    expect(lines).toContain('  База знаний/Сроки ← 2 ops');

    const drafts = await db.select().from(kbDrafts);
    const open = drafts.filter((draft) => draft.status === 'open');
    expect(open).toHaveLength(1);
    expect(drafts.find((draft) => draft.id === legacyScriptId)?.status).toBe('discarded');
    expect(drafts.find((draft) => draft.id === legacyKnowledgeId)?.status).toBe('discarded');
    const [draft] = open;
    expect(draft).toMatchObject({ title: 'Обучение из переписки' });
    expect(draft!.ops).toEqual([
      expect.objectContaining({ op: 'note_create', path: 'База знаний/Сроки' }),
      expect.objectContaining({ op: 'note_update', noteId }),
    ]);
    const rows = await db.select().from(kbGenerationProposals);
    const row = (id: string) => rows.find((candidate) => candidate.id === id);
    expect(row(proposal.terms)).toMatchObject({ status: 'drafted', draftId: draft!.id, draftOpIndex: 0, revision: 1 });
    expect(row(proposal.delivery)).toMatchObject({ status: 'drafted', draftId: draft!.id, draftOpIndex: 0 });
    expect(row(proposal.payment)).toMatchObject({ status: 'drafted', draftId: draft!.id, draftOpIndex: 1 });
    expect(row(proposal.price)).toMatchObject({ status: 'pending', draftId: null, draftOpIndex: null, revision: 2 });
    expect(await db.select().from(kbGenerationDrafts).where(eq(kbGenerationDrafts.draftId, draft!.id)))
      .toEqual([expect.objectContaining({ runId, requestKey: 'old' })]);
  });

  it('gives up on an agent whose drafts changed while the model was answering', async () => {
    let inserted = false;
    const model = topicModel(async () => {
      if (inserted) return;
      inserted = true;
      await db.insert(kbDrafts).values({
        agentId, title: 'Обучение из переписки', origin: 'manual', base: {},
        ops: [{ op: 'note_create', path: 'База знаний/Новое', body: 'Новое.' }],
      });
    });

    const [result] = await regroupWhatsAppDrafts(db, { model, credentialsKey: key, log: () => undefined }, { dryRun: false });

    expect(result).toMatchObject({ outcome: 'skipped', reason: 'drafts_changed' });
    expect((await db.select().from(kbDrafts)).filter((draft) => draft.status === 'open')).toHaveLength(3);
  });
});
