import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { accounts, agents, kbDrafts, kbGenerationBatches, kbGenerationProposals, kbGenerationRuns, users } from '../src/db/schema.js';
import { cancelGenerationRun } from '../src/lib/knowledge/generation-run.js';
import { createGenerationCategoryDrafts, createGenerationDraft, updateGenerationProposal } from '../src/lib/knowledge/generation-review.js';
import { withDb } from './helpers/db.js';

let db: Awaited<ReturnType<typeof withDb>>;
let agentId: string;
let userId: string;
let runId: string;
let proposalId: string;

beforeEach(async () => {
  db = await withDb();
  const [account] = await db.insert(accounts).values({ name: 'Review' }).returning();
  const [user] = await db.insert(users).values({ email: 'review@example.test', passwordHash: 'x', name: 'Owner', initials: 'OW' }).returning();
  userId = user!.id;
  const [agent] = await db.insert(agents).values({ accountId: account!.id, name: 'Agent' }).returning();
  agentId = agent!.id;
  const selection = { conversationIds: [], from: '2026-09-01T00:00:00Z', to: '2026-09-02T00:00:00Z' };
  const counts = { selectedConversations: 0, selectedMessages: 0, eligibleMessages: 0, eligibleCharacters: 0, skippedAiOrSystem: 0, skippedUnsupported: 0, skippedEmpty: 0, skippedSensitive: 0, skippedOversize: 0, skippedNoSeller: 0 };
  const [run] = await db.insert(kbGenerationRuns).values({ agentId, userId, requestedPreviewId: crypto.randomUUID(), requestKey: 'review', selection, manifest: { messages: [], batches: [] }, counts, modelId: 'model', temperature: '0.30', status: 'completed' }).returning();
  runId = run!.id;
  const [batch] = await db.insert(kbGenerationBatches).values({ runId, ordinal: 0, manifest: { ordinal: 0, conversationId: crypto.randomUUID(), messages: [], characterCount: 0 }, status: 'done' }).returning();
  const [proposal] = await db.insert(kbGenerationProposals).values({ runId, batchId: batch!.id, fingerprint: 'one', path: 'База знаний/Delivery', body: 'Two days', sources: [] }).returning();
  proposalId = proposal!.id;
});

describe('generation review', () => {
  it('uses optimistic revisions when editing a pending proposal', async () => {
    await updateGenerationProposal(db, agentId, proposalId, { revision: 1, body: 'Three days' });
    await expect(updateGenerationProposal(db, agentId, proposalId, { revision: 1, body: 'Four days' })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('restores a rejected proposal to pending with its current revision', async () => {
    await updateGenerationProposal(db, agentId, proposalId, { revision: 1, status: 'rejected' });

    await updateGenerationProposal(db, agentId, proposalId, { revision: 2, status: 'pending' });

    const [proposal] = await db.select().from(kbGenerationProposals).where(eq(kbGenerationProposals.id, proposalId));
    expect(proposal).toMatchObject({ status: 'pending', revision: 3 });
  });

  it('recomputes the fingerprint and atomically refuses a duplicate after an edit', async () => {
    const path = 'Returns';
    const body = 'Within fourteen days';
    const duplicateFingerprint = createHash('sha256')
      .update(`${path.toLocaleLowerCase('ru')}\n${body.toLocaleLowerCase('ru')}`)
      .digest('hex');
    const [batch] = await db.select().from(kbGenerationBatches).where(eq(kbGenerationBatches.runId, runId));
    await db.insert(kbGenerationProposals).values({
      runId,
      batchId: batch!.id,
      fingerprint: duplicateFingerprint,
      path,
      body,
      sources: [],
    });

    await expect(updateGenerationProposal(db, agentId, proposalId, { revision: 1, path, body }))
      .rejects.toMatchObject({ statusCode: 409 });

    const [proposal] = await db.select().from(kbGenerationProposals).where(eq(kbGenerationProposals.id, proposalId));
    expect(proposal).toMatchObject({ fingerprint: 'one', path: 'База знаний/Delivery', body: 'Two days', revision: 1 });
  });

  it('converts an explicit selection once and returns the same draft on replay', async () => {
    const input = { proposalIds: [proposalId], revisions: { [proposalId]: 1 } };
    const first = await createGenerationDraft(db, agentId, userId, runId, input);
    const second = await createGenerationDraft(db, agentId, userId, runId, input);
    expect(second).toEqual(first);
    expect((await db.select().from(kbGenerationProposals).where(eq(kbGenerationProposals.id, proposalId)))[0]).toMatchObject({ status: 'drafted', draftId: first.draftId, draftOpIndex: 0 });
    expect((await db.select().from(kbDrafts).where(eq(kbDrafts.id, first.draftId)))[0]?.title).toBe('Знания из WhatsApp · 1');
  });

  it('creates one review draft per non-empty category and is idempotent', async () => {
    const [batch] = await db.select().from(kbGenerationBatches).where(eq(kbGenerationBatches.runId, runId));
    const [script, rejected, secondKnowledge] = await db.insert(kbGenerationProposals).values([
      { runId, batchId: batch!.id, fingerprint: 'script', path: 'Скрипт/Первичный контакт', body: 'Уточните задачу клиента.', sources: [] },
      { runId, batchId: batch!.id, fingerprint: 'rejected', path: 'Скрипт/Возражения', body: 'Не использовать.', sources: [], status: 'rejected' },
      { runId, batchId: batch!.id, fingerprint: 'knowledge-2', path: 'База знаний/Delivery', body: 'Стоимость зависит от адреса.', sources: [] },
    ]).returning();

    const first = await createGenerationCategoryDrafts(db, agentId, userId, runId);
    const second = await createGenerationCategoryDrafts(db, agentId, userId, runId);

    expect(first).toHaveLength(2);
    expect(second).toEqual([]);
    const drafts = await db.select().from(kbDrafts);
    expect(drafts).toHaveLength(2);
    expect(drafts.map((draft) => ({ title: draft.title, ops: draft.ops }))).toEqual(expect.arrayContaining([
      { title: 'База знаний из WhatsApp', ops: [{ op: 'note_create', path: 'База знаний/Delivery', body: 'Two days\n\nСтоимость зависит от адреса.' }] },
      { title: 'Скрипт продаж из WhatsApp', ops: [{ op: 'note_create', path: 'Скрипт/Первичный контакт', body: 'Уточните задачу клиента.' }] },
    ]));
    expect((await db.select().from(kbGenerationProposals).where(eq(kbGenerationProposals.id, script!.id)))[0])
      .toMatchObject({ status: 'drafted', draftOpIndex: 0 });
    const [firstKnowledge] = await db.select().from(kbGenerationProposals).where(eq(kbGenerationProposals.id, proposalId));
    const [otherKnowledge] = await db.select().from(kbGenerationProposals).where(eq(kbGenerationProposals.id, secondKnowledge!.id));
    expect(otherKnowledge).toMatchObject({ status: 'drafted', draftId: firstKnowledge!.draftId, draftOpIndex: firstKnowledge!.draftOpIndex });
    expect((await db.select().from(kbGenerationProposals).where(eq(kbGenerationProposals.id, rejected!.id)))[0])
      .toMatchObject({ status: 'rejected', draftId: null, draftOpIndex: null });
  });

  it('does not create an empty or uncategorized draft', async () => {
    await db.update(kbGenerationProposals).set({ status: 'rejected' }).where(eq(kbGenerationProposals.id, proposalId));
    const [batch] = await db.select().from(kbGenerationBatches).where(eq(kbGenerationBatches.runId, runId));
    await db.insert(kbGenerationProposals).values({
      runId,
      batchId: batch!.id,
      fingerprint: 'legacy',
      path: 'Legacy/Note',
      body: 'Old uncategorized proposal.',
      sources: [],
    });

    expect(await createGenerationCategoryDrafts(db, agentId, userId, runId)).toEqual([]);
    expect(await db.select().from(kbDrafts)).toHaveLength(0);
  });

  it('does not create drafts after cancellation was requested', async () => {
    await db.update(kbGenerationRuns).set({ status: 'running', cancelRequestedAt: new Date() }).where(eq(kbGenerationRuns.id, runId));

    expect(await createGenerationCategoryDrafts(db, agentId, userId, runId)).toEqual([]);
    expect(await db.select().from(kbDrafts)).toHaveLength(0);
    expect((await db.select().from(kbGenerationProposals).where(eq(kbGenerationProposals.id, proposalId)))[0])
      .toMatchObject({ status: 'pending', draftId: null, draftOpIndex: null });
  });

  it('atomically completes a finalized run before a later cancellation', async () => {
    await db.update(kbGenerationRuns).set({ status: 'running' }).where(eq(kbGenerationRuns.id, runId));

    expect(await createGenerationCategoryDrafts(db, agentId, userId, runId, true)).toHaveLength(1);
    expect((await db.select().from(kbGenerationRuns).where(eq(kbGenerationRuns.id, runId)))[0])
      .toMatchObject({ status: 'completed', cancelRequestedAt: null });

    await cancelGenerationRun(db, agentId, runId);
    expect((await db.select().from(kbGenerationRuns).where(eq(kbGenerationRuns.id, runId)))[0])
      .toMatchObject({ status: 'completed', cancelRequestedAt: null });
  });

  it('rolls back when proposals sharing a path exceed the note body limit', async () => {
    const [batch] = await db.select().from(kbGenerationBatches).where(eq(kbGenerationBatches.runId, runId));
    await db.insert(kbGenerationProposals).values({
      runId,
      batchId: batch!.id,
      fingerprint: 'oversize-combined',
      path: 'База знаний/Delivery',
      body: 'x'.repeat(199_995),
      sources: [],
    });

    await expect(createGenerationCategoryDrafts(db, agentId, userId, runId))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(await db.select().from(kbDrafts)).toHaveLength(0);
    expect(await db.select().from(kbGenerationProposals).where(eq(kbGenerationProposals.status, 'drafted'))).toHaveLength(0);
  });
});
