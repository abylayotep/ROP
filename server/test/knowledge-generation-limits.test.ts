import { describe, expect, it } from 'vitest';
import { GENERATION_LIMITS } from '../src/lib/knowledge/generation-limits.js';
import { accounts, agents, contacts, conversations, messages, whatsappNumbers } from '../src/db/schema.js';
import { previewSelection } from '../src/lib/knowledge/generation-selection.js';
import { withDb } from './helpers/db.js';

describe('knowledge generation limits', () => {
  it('accepts up to 200 selected conversations while retaining the other safety caps', () => {
    expect(GENERATION_LIMITS).toMatchObject({
      maxConversations: 200,
      maxEligibleMessages: 5_000,
      maxInputCharacters: 200_000,
    });
  });

  it('previews 200 owned conversations and rejects a 201st before processing', async () => {
    const db = await withDb();
    const [account] = await db.insert(accounts).values({ name: 'History limits' }).returning();
    const [agent] = await db.insert(agents).values({ accountId: account!.id, name: 'History' }).returning();
    const [number] = await db.insert(whatsappNumbers).values({
      agentId: agent!.id, displayPhone: '+77000000001', connectionKind: 'linked',
      linkedJid: '77000000001@s.whatsapp.net', linkedState: 'open',
    }).returning();
    const people = await db.insert(contacts).values(Array.from({ length: 201 }, (_, index) => ({
      agentId: agent!.id, phone: String(77000001000 + index),
    }))).returning();
    const chats = await db.insert(conversations).values(people.map((person) => ({
      agentId: agent!.id, contactId: person.id, whatsappNumberId: number!.id,
    }))).returning();
    const selection = { conversationIds: chats.slice(0, 200).map(({ id }) => id),
      from: '2026-08-01T00:00:00Z', to: '2026-09-01T00:00:00Z' };
    await db.insert(messages).values(chats.slice(0, 200).map(chat => ({
      conversationId: chat.id, direction: 'out', author: 'phone', kind: 'text',
      body: 'Delivery takes two days.', sentAt: new Date('2026-08-15T12:00:00Z'),
    })));
    const preview = await previewSelection(db, agent!.id, selection);
    expect(preview.counts.selectedConversations).toBe(200);
    expect(preview.counts.eligibleMessages).toBe(200);
    expect(preview.batchCount).toBe(200);
    expect(preview.maxCalls).toBe(200);
    await expect(previewSelection(db, agent!.id, {
      ...selection, conversationIds: chats.map(({ id }) => id),
    })).rejects.toMatchObject({ statusCode: 400 });
  });
});
