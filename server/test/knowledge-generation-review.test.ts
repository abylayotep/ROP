import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { accounts, agents, kbDrafts, kbGenerationBatches, kbGenerationProposals, kbGenerationRuns, users } from '../src/db/schema.js';
import { createGenerationDraft, updateGenerationProposal } from '../src/lib/knowledge/generation-review.js';
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
  const [proposal] = await db.insert(kbGenerationProposals).values({ runId, batchId: batch!.id, fingerprint: 'one', path: 'Delivery', body: 'Two days', sources: [] }).returning();
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
    expect(proposal).toMatchObject({ fingerprint: 'one', path: 'Delivery', body: 'Two days', revision: 1 });
  });

  it('converts an explicit selection once and returns the same draft on replay', async () => {
    const input = { proposalIds: [proposalId], revisions: { [proposalId]: 1 } };
    const first = await createGenerationDraft(db, agentId, userId, runId, input);
    const second = await createGenerationDraft(db, agentId, userId, runId, input);
    expect(second).toEqual(first);
    expect((await db.select().from(kbGenerationProposals).where(eq(kbGenerationProposals.id, proposalId)))[0]).toMatchObject({ status: 'drafted', draftId: first.draftId, draftOpIndex: 0 });
    expect((await db.select().from(kbDrafts).where(eq(kbDrafts.id, first.draftId)))[0]?.title).toBe('Знания из WhatsApp · 1');
  });
});
