import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  agents,
  kbGenerationBatches,
  kbGenerationPreviews,
  kbGenerationProposals,
  kbGenerationRuns,
} from '../src/db/schema.js';
import { createAccountWithOwner } from '../src/lib/provision.js';
import type { GenerationManifest, GenerationStoredCounts } from '../src/lib/knowledge/generation-types.js';
import { withDb } from './helpers/db.js';

let db: Awaited<ReturnType<typeof withDb>>;
let agentId: string;
let userId: string;

const selection = {
  conversationIds: ['00000000-0000-4000-8000-000000000001'],
  from: '2026-08-01T00:00:00.000Z',
  to: '2026-09-01T00:00:00.000Z',
};
const manifest: GenerationManifest = { messages: [], batches: [] };
const counts: GenerationStoredCounts = {
  selectedConversations: 1,
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

beforeEach(async () => {
  db = await withDb();
  const seeded = await createAccountWithOwner(db, {
    company: 'Schema fixture',
    email: 'generation@example.test',
    name: 'Owner',
    initials: 'OW',
    password: 'correct-horse-battery',
  });
  userId = seeded.userId;
  const [agent] = await db.insert(agents).values({ accountId: seeded.accountId, name: 'Agent' }).returning();
  agentId = agent!.id;
});

async function insertRun(requestKey: string, status = 'queued') {
  return db.insert(kbGenerationRuns).values({
    agentId,
    userId,
    requestedPreviewId: '00000000-0000-4000-8000-000000000099',
    requestKey,
    selection,
    manifest,
    counts,
    modelId: 'openai/gpt-4o-mini',
    temperature: '0.30',
    status,
  }).returning();
}

describe('knowledge generation schema', () => {
  it('keeps one request key per agent', async () => {
    await insertRun('same-key', 'completed');
    await expect(insertRun('same-key', 'failed')).rejects.toThrow();
  });

  it('keeps the requested preview identity after preview cleanup', async () => {
    const [preview] = await db.insert(kbGenerationPreviews).values({
      agentId,
      userId,
      selection,
      manifest,
      counts,
      modelId: 'openai/gpt-4o-mini',
      expiresAt: new Date(Date.now() + 60_000),
    }).returning();
    const [run] = await db.insert(kbGenerationRuns).values({
      agentId,
      userId,
      requestedPreviewId: preview!.id,
      requestKey: 'durable-preview',
      selection,
      manifest,
      counts,
      modelId: 'openai/gpt-4o-mini',
      temperature: '0.30',
      status: 'completed',
    }).returning();

    await db.delete(kbGenerationPreviews).where(eq(kbGenerationPreviews.id, preview!.id));

    const [stored] = await db.select().from(kbGenerationRuns).where(eq(kbGenerationRuns.id, run!.id));
    expect(stored?.requestedPreviewId).toBe(preview!.id);
  });

  it('allows only one active run per agent', async () => {
    await insertRun('first', 'running');
    await expect(insertRun('second', 'queued')).rejects.toThrow();
    await db.update(kbGenerationRuns).set({ status: 'failed' }).where(eq(kbGenerationRuns.agentId, agentId));
    await expect(insertRun('third', 'queued')).resolves.toHaveLength(1);
  });

  it('keeps batch ordinals and proposal fingerprints unique inside a run', async () => {
    const [run] = await insertRun('batch-key');
    const batch = { runId: run!.id, ordinal: 0, manifest: { ordinal: 0, conversationId: selection.conversationIds[0]!, messages: [], characterCount: 0 } };
    const [storedBatch] = await db.insert(kbGenerationBatches).values(batch).returning();
    await expect(db.insert(kbGenerationBatches).values(batch)).rejects.toThrow();

    const proposal = {
      runId: run!.id,
      batchId: storedBatch!.id,
      fingerprint: 'sha256:one',
      path: 'Delivery',
      body: 'Delivery terms',
      sources: [],
    };
    await db.insert(kbGenerationProposals).values(proposal);
    await expect(db.insert(kbGenerationProposals).values(proposal)).rejects.toThrow();
  });

  it('cascades all generation records when the agent is deleted', async () => {
    await db.insert(kbGenerationPreviews).values({
      agentId,
      userId,
      selection,
      manifest,
      counts,
      modelId: 'openai/gpt-4o-mini',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const [run] = await insertRun('cascade', 'completed');
    const [batch] = await db.insert(kbGenerationBatches).values({
      runId: run!.id,
      ordinal: 0,
      manifest: { ordinal: 0, conversationId: selection.conversationIds[0]!, messages: [], characterCount: 0 },
    }).returning();
    await db.insert(kbGenerationProposals).values({
      runId: run!.id,
      batchId: batch!.id,
      fingerprint: 'sha256:cascade',
      path: 'Payment',
      body: 'Payment terms',
      sources: [],
    });

    await db.delete(agents).where(eq(agents.id, agentId));

    expect(await db.select().from(kbGenerationPreviews)).toHaveLength(0);
    expect(await db.select().from(kbGenerationRuns)).toHaveLength(0);
    expect(await db.select().from(kbGenerationBatches)).toHaveLength(0);
    expect(await db.select().from(kbGenerationProposals)).toHaveLength(0);
  });
});
