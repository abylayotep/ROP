import { eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { contacts, conversations, instagramAccounts, instagramContacts, instagramEvents, messages } from '../../db/schema.js';
import type { TurnDeps } from '../ai/turn.js';
import { advanceConversation, runTurns, type Touched } from '../whatsapp/store.js';

const MAX_ATTEMPTS = 5;
type Claimed = { id: string; payload: unknown; received_at: Date };
const rowsOf = <T>(value: unknown): T[] => Array.isArray(value) ? value as T[] : ((value as { rows?: T[] }).rows ?? []);
const at = (timestamp?: number) => new Date(timestamp && timestamp > 10_000_000_000 ? timestamp : (timestamp ?? Date.now() / 1000) * 1000);

export async function processPendingInstagramEvents(db: Db, deps: TurnDeps): Promise<{ processed: number; failed: number }> {
  const result = await db.execute(sql`update instagram_events set attempts = attempts + 1, processing_at = now() where id in
    (select id from instagram_events where processed_at is null and attempts < ${MAX_ATTEMPTS}
     and (processing_at is null or processing_at < now() - interval '2 minutes')
     order by received_at limit 50 for update skip locked) returning *`);
  const pending = rowsOf<Claimed>(result).sort((a, b) => a.received_at.getTime() - b.received_at.getTime());
  let processed = 0; let failed = 0;
  for (const event of pending) {
    try {
      const [state] = await db.select({ conversationIds: instagramEvents.conversationIds }).from(instagramEvents).where(eq(instagramEvents.id, event.id));
      const resumed = state?.conversationIds
        ? await db.select({ id: conversations.id, agentId: conversations.agentId }).from(conversations)
          .where(inArray(conversations.id, state.conversationIds))
        : null;
      const touched = resumed ? new Map(resumed.map((row) => [row.id, row.agentId])) : await applyInstagramPayload(db, event.payload, event.id);
      const errors = await runTurns(db, deps, touched);
      await db.update(instagramEvents).set({ processedAt: new Date(), processingAt: null, error: errors.length ? errors.join('; ') : null }).where(eq(instagramEvents.id, event.id));
      processed += 1;
    } catch (error) {
      failed += 1;
      await db.update(instagramEvents).set({ processingAt: null, error: error instanceof Error ? error.message : String(error) }).where(eq(instagramEvents.id, event.id));
    }
  }
  return { processed, failed };
}

export async function applyInstagramPayload(db: Db, payload: unknown, eventId?: string): Promise<Touched> {
  return db.transaction(async (tx) => {
    const transaction = tx as unknown as Db;
    const touched = await applyInstagramPayloadTx(transaction, payload);
    if (eventId) await transaction.update(instagramEvents).set({ conversationIds: [...touched.keys()] })
      .where(eq(instagramEvents.id, eventId));
    return touched;
  });
}

async function applyInstagramPayloadTx(db: Db, payload: unknown): Promise<Touched> {
  const root = payload as { object?: string; entry?: Array<{ id?: string; messaging?: unknown[] }> };
  if (root.object !== 'instagram' || !Array.isArray(root.entry)) throw new Error('invalid Instagram webhook');
  const touched: Touched = new Map();
  for (const entry of root.entry) {
    if (!entry.id) continue;
    const [account] = await db.select().from(instagramAccounts).where(eq(instagramAccounts.instagramUserId, entry.id));
    if (!account) throw new Error(`unknown Instagram account ${entry.id}`);
    for (const raw of entry.messaging ?? []) {
      const item = raw as { sender?: { id?: string }; timestamp?: number;
        message?: { mid?: string; text?: string; is_echo?: boolean; attachments?: unknown[] } };
      const message = item.message;
      const senderId = item.sender?.id;
      if (!message?.mid || !senderId || message.is_echo || senderId === account.instagramUserId) continue;
      const [known] = await db.select({ id: messages.id }).from(messages).where(eq(messages.instagramMessageId, message.mid));
      if (known) continue;

      let [identity] = await db.select({ contact: contacts, instagram: instagramContacts })
        .from(instagramContacts).innerJoin(contacts, eq(contacts.id, instagramContacts.contactId))
        .where(sql`${instagramContacts.instagramAccountId} = ${account.id} and ${instagramContacts.instagramUserId} = ${senderId}`);
      if (!identity) {
        const [contact] = await db.insert(contacts).values({ agentId: account.agentId, phone: null, name: null }).returning();
        const [instagram] = await db.insert(instagramContacts).values({ contactId: contact!.id, agentId: account.agentId, instagramAccountId: account.id, instagramUserId: senderId }).returning();
        identity = { contact: contact!, instagram: instagram! };
      }
      const [conversation] = await db.insert(conversations).values({ agentId: account.agentId,
        contactId: identity.contact.id, instagramAccountId: account.id })
        .onConflictDoUpdate({ target: [conversations.instagramAccountId, conversations.contactId],
          targetWhere: sql`${conversations.instagramAccountId} is not null`, set: { contactId: identity.contact.id } })
        .returning();
      const sentAt = at(item.timestamp);
      const unsupported = !message.text && (message.attachments?.length ?? 0) > 0;
      const [stored] = await db.insert(messages).values({ conversationId: conversation!.id,
        instagramMessageId: message.mid, direction: 'in', author: 'client',
        kind: unsupported ? 'unsupported' : 'text', body: message.text ?? (unsupported ? 'Вложение Instagram пока не поддерживается.' : null), sentAt })
        .onConflictDoNothing({ target: messages.instagramMessageId }).returning({ id: messages.id });
      if (!stored) continue;
      await advanceConversation(db, conversation!.id, sentAt, true);
      if (!unsupported && message.text) touched.set(conversation!.id, account.agentId);
    }
  }
  return touched;
}
