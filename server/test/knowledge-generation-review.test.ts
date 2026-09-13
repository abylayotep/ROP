import { createHash } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../src/db/schema.js';
import {
  accounts,
  agentRules,
  agents,
  kbDrafts,
  kbGenerationBatches,
  kbGenerationDrafts,
  kbGenerationProposals,
  kbGenerationRuns,
  kbNotes,
  users,
} from '../src/db/schema.js';
import { createGenerationDraft, updateGenerationProposal } from '../src/lib/knowledge/generation-review.js';
import { mergeDuplicateWhatsAppDrafts } from '../src/lib/knowledge/whatsapp-drafts.js';
import { withDb } from './helpers/db.js';

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://rakurs:rakurs@localhost:55432/rakurs_test';

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

  it('persists selection with an optimistic revision and rejects a stale selection write', async () => {
    await updateGenerationProposal(db, agentId, proposalId, { revision: 1, selected: true });
    await expect(updateGenerationProposal(db, agentId, proposalId, { revision: 1, selected: false }))
      .rejects.toMatchObject({ statusCode: 409 });

    const [proposal] = await db.select().from(kbGenerationProposals).where(eq(kbGenerationProposals.id, proposalId));
    expect(proposal).toMatchObject({ selected: true, revision: 2 });
  });

  it('serializes a selection update on another proposal behind the draft run lock', async () => {
    const [batch] = await db.select().from(kbGenerationBatches).where(eq(kbGenerationBatches.runId, runId));
    const [other] = await db.insert(kbGenerationProposals).values({
      runId,
      batchId: batch!.id,
      fingerprint: 'concurrent-selection',
      path: 'База знаний/Other',
      body: 'Other body',
      sources: [],
    }).returning();
    await db.update(kbGenerationProposals).set({ selected: true }).where(eq(kbGenerationProposals.id, proposalId));

    let releaseBlocker!: () => void;
    let blockerLocked!: () => void;
    const release = new Promise<void>((resolve) => { releaseBlocker = resolve; });
    const locked = new Promise<void>((resolve) => { blockerLocked = resolve; });
    const blocker = db.transaction(async (tx) => {
      await tx.select({ id: kbGenerationProposals.id }).from(kbGenerationProposals)
        .where(eq(kbGenerationProposals.id, proposalId)).for('update');
      blockerLocked();
      await release;
    });
    await locked;

    const blockedQueries = async (table: string): Promise<number> => {
      const rows = await db.execute(sql<{ count: number }>`
        select count(*)::int as count
        from pg_stat_activity
        where datname = current_database()
          and wait_event_type = 'Lock'
          and query ilike ${`%${table}%`}
      `);
      return Number(rows[0]?.count ?? 0);
    };
    const waitUntilBlocked = async (table: string): Promise<boolean> => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (await blockedQueries(table) > 0) return true;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return false;
    };

    const draftOutcome = createGenerationDraft(db, agentId, userId, runId, {
      proposalIds: [proposalId],
      revisions: { [proposalId]: 1 },
    }).then((value) => ({ value }), (error: unknown) => ({ error }));
    expect(await waitUntilBlocked('kb_generation_proposals')).toBe(true);

    const patchApplication = `generation-proposal-patch-${crypto.randomUUID()}`;
    const patchSql = postgres(DATABASE_URL, { max: 1, connection: { application_name: patchApplication } });
    const patchDb = drizzle(patchSql, { schema });
    const patchIsBlocked = async (): Promise<boolean> => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const rows = await db.execute(sql<{ blocked: boolean }>`
          select exists (
            select 1
            from pg_stat_activity
            where datname = current_database()
              and application_name = ${patchApplication}
              and cardinality(pg_blocking_pids(pid)) > 0
          ) as blocked
        `);
        if (rows[0]?.blocked === true) return true;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return false;
    };
    let updateSettled = false;
    const updatePromise = updateGenerationProposal(patchDb, agentId, other!.id, { revision: 1, selected: true })
      .finally(() => { updateSettled = true; });
    const updateWaitsForRun = await Promise.race([
      updatePromise.then(() => false),
      patchIsBlocked(),
    ]);

    let outcome: Awaited<typeof draftOutcome> | undefined;
    try {
      expect(updateWaitsForRun).toBe(true);
      expect(updateSettled).toBe(false);
    } finally {
      releaseBlocker();
      await blocker;
      outcome = await draftOutcome;
      await updatePromise;
      await patchSql.end();
    }

    expect(outcome).toHaveProperty('value');
    if (!outcome || !('value' in outcome)) throw outcome?.error;
    const draft = outcome.value;
    expect((await db.select().from(kbGenerationProposals).where(eq(kbGenerationProposals.id, proposalId)))[0])
      .toMatchObject({ status: 'drafted', draftId: draft.draftId, selected: false });
    expect((await db.select().from(kbGenerationProposals).where(eq(kbGenerationProposals.id, other!.id)))[0])
      .toMatchObject({ status: 'pending', selected: true, revision: 2 });
  });

  it('restores a rejected proposal to pending with its current revision', async () => {
    await updateGenerationProposal(db, agentId, proposalId, { revision: 1, status: 'rejected' });

    await updateGenerationProposal(db, agentId, proposalId, { revision: 2, status: 'pending' });

    const [proposal] = await db.select().from(kbGenerationProposals).where(eq(kbGenerationProposals.id, proposalId));
    expect(proposal).toMatchObject({ status: 'pending', revision: 3 });
  });

  it('never mutates, restores, or drafts a legacy raw proposal', async () => {
    const [batch] = await db.select().from(kbGenerationBatches).where(eq(kbGenerationBatches.runId, runId));
    const [legacyRaw] = await db.insert(kbGenerationProposals).values({
      runId,
      batchId: batch!.id,
      fingerprint: 'raw:legacy:0:hash',
      path: 'База знаний/Legacy raw',
      body: 'Immutable evidence.',
      sources: [],
      status: 'rejected',
    }).returning();

    await expect(updateGenerationProposal(db, agentId, legacyRaw!.id, { revision: 1, status: 'pending' }))
      .rejects.toMatchObject({ statusCode: 409 });
    await expect(createGenerationDraft(db, agentId, userId, runId, {
      proposalIds: [legacyRaw!.id], revisions: { [legacyRaw!.id]: 1 },
    })).rejects.toMatchObject({ statusCode: 404 });
    expect((await db.select().from(kbGenerationProposals).where(eq(kbGenerationProposals.id, legacyRaw!.id)))[0])
      .toMatchObject({ status: 'rejected', revision: 1, draftId: null });
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

  it('keeps proposal kind consistent when an owner changes the path prefix', async () => {
    await updateGenerationProposal(db, agentId, proposalId, {
      revision: 1,
      path: 'Скрипт/Доставка',
    });
    expect((await db.select().from(kbGenerationProposals).where(eq(kbGenerationProposals.id, proposalId)))[0])
      .toMatchObject({ kind: 'script', path: 'Скрипт/Доставка', revision: 2 });

    await updateGenerationProposal(db, agentId, proposalId, {
      revision: 2,
      path: 'База знаний/Доставка',
    });
    expect((await db.select().from(kbGenerationProposals).where(eq(kbGenerationProposals.id, proposalId)))[0])
      .toMatchObject({ kind: 'knowledge', path: 'База знаний/Доставка', revision: 3 });
  });

  it('converts the complete persisted checked set once and records the run relation without publishing', async () => {
    await updateGenerationProposal(db, agentId, proposalId, { revision: 1, selected: true });
    const input = { proposalIds: [proposalId], revisions: { [proposalId]: 2 } };
    const first = await createGenerationDraft(db, agentId, userId, runId, input);
    const second = await createGenerationDraft(db, agentId, userId, runId, input);
    expect(second).toEqual(first);
    expect(first.draftIds).toEqual([first.draftId]);
    expect((await db.select().from(kbGenerationProposals).where(eq(kbGenerationProposals.id, proposalId)))[0]).toMatchObject({ status: 'drafted', draftId: first.draftId, draftOpIndex: 0, revision: 3 });
    expect((await db.select().from(kbDrafts).where(eq(kbDrafts.id, first.draftId)))[0]?.title).toBe('База знаний из WhatsApp');
    expect(await db.select().from(kbGenerationDrafts)).toEqual([
      expect.objectContaining({ runId, draftId: first.draftId }),
    ]);
    expect(await db.select().from(kbNotes)).toHaveLength(0);
    expect(await db.select().from(agentRules)).toHaveLength(0);
  });

  it('atomically creates one idempotent draft per selected proposal kind', async () => {
    const [batch] = await db.select().from(kbGenerationBatches).where(eq(kbGenerationBatches.runId, runId));
    const [script] = await db.insert(kbGenerationProposals).values({
      runId,
      batchId: batch!.id,
      fingerprint: 'script-selected',
      kind: 'script',
      path: 'Скрипт/Доставка',
      body: 'Подскажите адрес, и я рассчитаю доставку.',
      sources: [],
      selected: true,
    }).returning();
    await updateGenerationProposal(db, agentId, proposalId, { revision: 1, selected: true });
    const input = {
      proposalIds: [proposalId, script!.id],
      revisions: { [proposalId]: 2, [script!.id]: 1 },
    };

    const first = await createGenerationDraft(db, agentId, userId, runId, input);
    const second = await createGenerationDraft(db, agentId, userId, runId, input);

    expect(second).toEqual(first);
    expect(first.draftIds).toHaveLength(2);
    const drafts = await db.select().from(kbDrafts);
    const knowledgeDraft = drafts.find((draft) => draft.title === 'База знаний из WhatsApp');
    const scriptDraft = drafts.find((draft) => draft.title === 'Скрипт продаж из WhatsApp');
    expect(knowledgeDraft?.ops).toEqual([
      { op: 'note_create', path: 'База знаний/Delivery', body: 'Two days' },
    ]);
    expect(scriptDraft?.ops).toEqual([
      { op: 'note_create', path: 'Скрипт/Доставка', body: 'Подскажите адрес, и я рассчитаю доставку.' },
    ]);
    expect(first).toEqual({
      draftId: knowledgeDraft!.id,
      draftIds: [knowledgeDraft!.id, scriptDraft!.id],
    });
    expect((await db.select().from(kbGenerationProposals).where(eq(kbGenerationProposals.id, proposalId)))[0])
      .toMatchObject({ status: 'drafted', selected: false, draftId: knowledgeDraft!.id, draftOpIndex: 0, revision: 3 });
    expect((await db.select().from(kbGenerationProposals).where(eq(kbGenerationProposals.id, script!.id)))[0])
      .toMatchObject({ status: 'drafted', selected: false, draftId: scriptDraft!.id, draftOpIndex: 0, revision: 2 });
    expect((await db.select().from(kbGenerationDrafts)).map((link) => link.draftId).sort())
      .toEqual([knowledgeDraft!.id, scriptDraft!.id].sort());
    expect(await db.select().from(kbNotes)).toHaveLength(0);
    expect(await db.select().from(agentRules)).toHaveLength(0);
  });

  it('rejects replaying only one draft from a mixed-kind request', async () => {
    const [batch] = await db.select().from(kbGenerationBatches).where(eq(kbGenerationBatches.runId, runId));
    const [script] = await db.insert(kbGenerationProposals).values({
      runId,
      batchId: batch!.id,
      fingerprint: 'mixed-subset-script',
      kind: 'script',
      path: 'Скрипт/Доставка',
      body: 'Подскажите адрес доставки.',
      sources: [],
      selected: true,
    }).returning();
    await updateGenerationProposal(db, agentId, proposalId, { revision: 1, selected: true });
    await createGenerationDraft(db, agentId, userId, runId, {
      proposalIds: [proposalId, script!.id],
      revisions: { [proposalId]: 2, [script!.id]: 1 },
    });

    await expect(createGenerationDraft(db, agentId, userId, runId, {
      proposalIds: [proposalId],
      revisions: { [proposalId]: 2 },
    })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('rejects combining drafts created by two independent requests', async () => {
    await updateGenerationProposal(db, agentId, proposalId, { revision: 1, selected: true });
    await createGenerationDraft(db, agentId, userId, runId, {
      proposalIds: [proposalId],
      revisions: { [proposalId]: 2 },
    });
    const [batch] = await db.select().from(kbGenerationBatches).where(eq(kbGenerationBatches.runId, runId));
    const [script] = await db.insert(kbGenerationProposals).values({
      runId,
      batchId: batch!.id,
      fingerprint: 'independent-script',
      kind: 'script',
      path: 'Скрипт/Оплата',
      body: 'Оплатить можно удобным для вас способом.',
      sources: [],
      selected: true,
    }).returning();
    await createGenerationDraft(db, agentId, userId, runId, {
      proposalIds: [script!.id],
      revisions: { [script!.id]: 1 },
    });

    await expect(createGenerationDraft(db, agentId, userId, runId, {
      proposalIds: [proposalId, script!.id],
      revisions: { [proposalId]: 2, [script!.id]: 1 },
    })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('merges a second request into the one open draft and lets the newer text win', async () => {
    await updateGenerationProposal(db, agentId, proposalId, { revision: 1, selected: true });
    const first = await createGenerationDraft(db, agentId, userId, runId, {
      proposalIds: [proposalId], revisions: { [proposalId]: 2 },
    });
    const [batch] = await db.select().from(kbGenerationBatches).where(eq(kbGenerationBatches.runId, runId));
    const [newer] = await db.insert(kbGenerationProposals).values({
      runId, batchId: batch!.id, fingerprint: 'newer-delivery', path: 'база знаний/delivery ', body: 'One day', sources: [], selected: true,
    }).returning();
    const [payment] = await db.insert(kbGenerationProposals).values({
      runId, batchId: batch!.id, fingerprint: 'payment', path: 'База знаний/Оплата', body: 'Kaspi', sources: [], selected: true,
    }).returning();

    const second = await createGenerationDraft(db, agentId, userId, runId, {
      proposalIds: [newer!.id, payment!.id], revisions: { [newer!.id]: 1, [payment!.id]: 1 },
    });

    expect(second.draftIds).toHaveLength(1);
    expect(second.draftId).not.toBe(first.draftId);
    const drafts = await db.select().from(kbDrafts);
    expect(drafts.find((draft) => draft.id === first.draftId)?.status).toBe('discarded');
    const open = drafts.filter((draft) => draft.status === 'open');
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ id: second.draftId, title: 'База знаний из WhatsApp' });
    expect(open[0]!.ops).toEqual([
      { op: 'note_create', path: 'база знаний/delivery ', body: 'One day' },
      { op: 'note_create', path: 'База знаний/Оплата', body: 'Kaspi' },
    ]);
    const proposals = await db.select().from(kbGenerationProposals);
    expect(proposals.find((row) => row.id === proposalId)).toMatchObject({ status: 'pending', draftId: null, draftOpIndex: null });
    expect(proposals.find((row) => row.id === newer!.id)).toMatchObject({ status: 'drafted', draftId: second.draftId, draftOpIndex: 0 });
    expect(proposals.find((row) => row.id === payment!.id)).toMatchObject({ status: 'drafted', draftId: second.draftId, draftOpIndex: 1 });

    await expect(createGenerationDraft(db, agentId, userId, runId, {
      proposalIds: [newer!.id, payment!.id], revisions: { [newer!.id]: 1, [payment!.id]: 1 },
    })).resolves.toEqual(second);
  });

  it('collapses duplicate open drafts left by earlier generations', async () => {
    const draft = (title: string, path: string, body: string, createdAt: string) => db.insert(kbDrafts).values({
      agentId, title, origin: 'manual', ops: [{ op: 'note_create', path, body }], base: {}, createdBy: userId, createdAt: new Date(createdAt),
    }).returning();
    const [older] = await draft('Скрипт продаж из WhatsApp', 'Скрипт/Приветствие', 'Здравствуйте', '2026-09-12T08:00:00Z');
    const [newer] = await draft('Скрипт продаж из WhatsApp · 4', 'Скрипт/Приветствие', 'Добрый день!', '2026-09-12T09:00:00Z');
    const [other] = await draft('Скрипт продаж из WhatsApp · 1', 'Скрипт/Оплата', 'Kaspi', '2026-09-12T10:00:00Z');
    await db.insert(kbGenerationDrafts).values({ runId, draftId: newer!.id, requestKey: 'k' });
    await db.update(kbGenerationProposals).set({ status: 'drafted', draftId: older!.id, draftOpIndex: 0 })
      .where(eq(kbGenerationProposals.id, proposalId));

    expect(await mergeDuplicateWhatsAppDrafts(db)).toBe(1);
    expect(await mergeDuplicateWhatsAppDrafts(db)).toBe(0);

    const open = (await db.select().from(kbDrafts)).filter((row) => row.status === 'open');
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ title: 'Скрипт продаж из WhatsApp', createdBy: userId });
    expect(open[0]!.ops).toEqual([
      { op: 'note_create', path: 'Скрипт/Приветствие', body: 'Добрый день!' },
      { op: 'note_create', path: 'Скрипт/Оплата', body: 'Kaspi' },
    ]);
    expect([older, newer, other].every(Boolean)).toBe(true);
    expect((await db.select().from(kbGenerationProposals).where(eq(kbGenerationProposals.id, proposalId)))[0])
      .toMatchObject({ status: 'pending', draftId: null });
    expect(await db.select().from(kbGenerationDrafts).where(eq(kbGenerationDrafts.draftId, open[0]!.id)))
      .toEqual([expect.objectContaining({ runId, requestKey: 'k' })]);
  });

  it('refuses a draft request that omits a proposal from the persisted checked set', async () => {
    const [batch] = await db.select().from(kbGenerationBatches).where(eq(kbGenerationBatches.runId, runId));
    const [second] = await db.insert(kbGenerationProposals).values({
      runId,
      batchId: batch!.id,
      fingerprint: 'second-selected',
      path: 'Скрипт/Delivery',
      body: 'It takes two days.',
      sources: [],
      selected: true,
    }).returning();
    await updateGenerationProposal(db, agentId, proposalId, { revision: 1, selected: true });

    await expect(createGenerationDraft(db, agentId, userId, runId, {
      proposalIds: [proposalId],
      revisions: { [proposalId]: 2 },
    })).rejects.toMatchObject({ statusCode: 409 });

    expect(await db.select().from(kbDrafts)).toHaveLength(0);
    expect((await db.select().from(kbGenerationProposals).where(eq(kbGenerationProposals.id, second!.id)))[0])
      .toMatchObject({ status: 'pending', selected: true, draftId: null });
  });

});
