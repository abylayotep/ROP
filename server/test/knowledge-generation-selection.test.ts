import { describe, expect, it } from 'vitest';
import { accounts, agents, contacts, conversations, messages, users, whatsappNumbers } from '../src/db/schema.js';
import { loadPreview, previewSelection } from '../src/lib/knowledge/generation-selection.js';
import { withDb } from './helpers/db.js';

async function seed() {
  const db = await withDb();
  const [account] = await db.insert(accounts).values({ name: 'Generation' }).returning();
  const [user] = await db.insert(users).values({
    email: 'selection@example.test', passwordHash: 'x', name: 'Owner', initials: 'OW',
  }).returning();
  const [agent] = await db.insert(agents).values({ accountId: account!.id, name: 'Agent' }).returning();
  const [number] = await db.insert(whatsappNumbers).values({
    agentId: agent!.id, phoneNumberId: 'selection-number', wabaId: 'waba', displayPhone: '+7', accessToken: 'x',
  }).returning();
  const [contact] = await db.insert(contacts).values({ agentId: agent!.id, phone: '77000000001' }).returning();
  const [conversation] = await db.insert(conversations).values({
    agentId: agent!.id, contactId: contact!.id, whatsappNumberId: number!.id,
  }).returning();
  return { db, agent: agent!, user: user!, conversation: conversation! };
}

describe('generation selection preview', () => {
  it('stores only hashes and batches redacted eligible messages', async () => {
    const { db, agent, user, conversation } = await seed();
    const sentAt = new Date('2026-09-01T10:00:00.000Z');
    await db.insert(messages).values([
      { conversationId: conversation.id, direction: 'in', author: 'client', kind: 'text', body: 'My email is buyer@example.test', sentAt },
      { conversationId: conversation.id, direction: 'out', author: 'phone', kind: 'text', body: 'Delivery takes two days', sentAt: new Date(sentAt.getTime() + 1) },
      { conversationId: conversation.id, direction: 'out', author: 'ai', kind: 'text', body: 'Ignore this', sentAt: new Date(sentAt.getTime() + 2) },
    ]);

    const result = await previewSelection(db, agent.id, {
      conversationIds: [conversation.id], from: '2026-09-01T00:00:00.000Z', to: '2026-09-02T00:00:00.000Z',
    }, user.id);
    const stored = await loadPreview(db, agent.id, result.previewId);

    expect(result).toMatchObject({ batchCount: 1, maxCalls: 1, maxOutputTokens: 2000, truncated: false });
    expect(result.counts).toMatchObject({ selectedMessages: 3, eligibleMessages: 2, skippedAiOrSystem: 1 });
    expect(JSON.stringify(stored.manifest)).not.toContain('Delivery takes two days');
    expect(stored.manifest.messages).toHaveLength(2);
  });

  it('rejects a selection containing another agent conversation as a whole', async () => {
    const first = await seed();
    const [otherAgent] = await first.db.insert(agents).values({ accountId: first.agent.accountId, name: 'Other' }).returning();
    const [number] = await first.db.insert(whatsappNumbers).values({
      agentId: otherAgent!.id, phoneNumberId: 'other-number', wabaId: 'waba', displayPhone: '+8', accessToken: 'x',
    }).returning();
    const [contact] = await first.db.insert(contacts).values({ agentId: otherAgent!.id, phone: '77000000002' }).returning();
    const [foreign] = await first.db.insert(conversations).values({
      agentId: otherAgent!.id, contactId: contact!.id, whatsappNumberId: number!.id,
    }).returning();

    await expect(previewSelection(first.db, first.agent.id, {
      conversationIds: [first.conversation.id, foreign!.id],
      from: '2026-09-01T00:00:00.000Z', to: '2026-09-02T00:00:00.000Z',
    }, first.user.id)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('refuses an expired or source-changed preview', async () => {
    const { db, agent, user, conversation } = await seed();
    const [message] = await db.insert(messages).values({
      conversationId: conversation.id, direction: 'out', author: 'operator', kind: 'text', body: 'Pay by card', sentAt: new Date('2026-09-01T10:00:00.000Z'),
    }).returning();
    const preview = await previewSelection(db, agent.id, {
      conversationIds: [conversation.id], from: '2026-09-01T00:00:00.000Z', to: '2026-09-02T00:00:00.000Z',
    }, user.id);
    await db.update(messages).set({ body: 'Pay by transfer' }).where((await import('drizzle-orm')).eq(messages.id, message!.id));

    await expect(loadPreview(db, agent.id, preview.previewId)).rejects.toMatchObject({ statusCode: 409 });
  });
});
