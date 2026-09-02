import { eq, isNull } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import {
  contacts,
  conversations,
  messages,
  whatsappEvents,
  whatsappNumbers,
} from '../../db/schema.js';
import type { GraphClient } from './graph.js';

/**
 * Turning stored webhook deliveries into rows.
 *
 * A function over pending events rather than code inside the route, for three reasons: the
 * route can answer Meta before any of this runs, the tests can drive it without HTTP, and a
 * delivery that failed to parse can be run again once the bug is fixed.
 */

export interface InboundDeps {
  graph: GraphClient;
  /** Decrypts a number's access token; media downloads need it. */
  key: Buffer;
  mediaDir: string;
}

/** The slice of Meta's payload this stage reads. Everything else is ignored on purpose. */
interface InboundMessage {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  image?: { id: string; mime_type?: string; caption?: string };
  audio?: { id: string; mime_type?: string };
  video?: { id: string; mime_type?: string; caption?: string };
  document?: { id: string; mime_type?: string; filename?: string; caption?: string };
  sticker?: { id: string; mime_type?: string };
}

interface StatusUpdate {
  id: string;
  status: string;
}

interface ChangeValue {
  metadata?: { phone_number_id?: string };
  contacts?: { profile?: { name?: string }; wa_id: string }[];
  messages?: InboundMessage[];
  statuses?: StatusUpdate[];
}

/** WhatsApp sends seconds; Postgres wants a Date. */
const at = (timestamp: string) => new Date(Number(timestamp) * 1000);

/**
 * The text a message carries, if it carries any. A caption counts.
 *
 * Keyed on the declared `type` rather than checking each field's presence: Meta only ever
 * populates the sub-object matching `type`, and reading by type is what keeps an unrenderable
 * kind (location, contacts, unsupported) from picking up text that belongs to a different field.
 */
function bodyOf(message: InboundMessage): string | null {
  switch (message.type) {
    case 'text':
      return message.text?.body ?? null;
    case 'image':
      return message.image?.caption ?? null;
    case 'video':
      return message.video?.caption ?? null;
    case 'document':
      return message.document?.caption ?? null;
    default:
      return null;
  }
}

export async function processPendingEvents(
  db: Db,
  deps: InboundDeps,
): Promise<{ processed: number; failed: number }> {
  const pending = await db
    .select()
    .from(whatsappEvents)
    .where(isNull(whatsappEvents.processedAt))
    .orderBy(whatsappEvents.receivedAt);

  let processed = 0;
  let failed = 0;

  for (const event of pending) {
    try {
      await applyPayload(db, deps, event.payload);
      await db
        .update(whatsappEvents)
        .set({ processedAt: new Date(), error: null })
        .where(eq(whatsappEvents.id, event.id));
      processed += 1;
    } catch (error) {
      // The row keeps its payload and gains a reason. One bad delivery must not stop the
      // queue: the next message in line is someone's live conversation.
      await db
        .update(whatsappEvents)
        .set({ error: error instanceof Error ? error.message : String(error) })
        .where(eq(whatsappEvents.id, event.id));
      failed += 1;
    }
  }

  return { processed, failed };
}

async function applyPayload(db: Db, deps: InboundDeps, payload: unknown): Promise<void> {
  const entries = (payload as { entry?: unknown }).entry;
  if (!Array.isArray(entries)) throw new Error('entry is not an array');

  for (const entry of entries) {
    const changes = (entry as { changes?: unknown }).changes;
    if (!Array.isArray(changes)) throw new Error('changes is not an array');

    for (const change of changes) {
      await applyChange(db, deps, (change as { value?: ChangeValue }).value ?? {});
    }
  }
}

async function applyChange(db: Db, deps: InboundDeps, value: ChangeValue): Promise<void> {
  const phoneNumberId = value.metadata?.phone_number_id;
  if (!phoneNumberId) return;

  const [number] = await db
    .select()
    .from(whatsappNumbers)
    .where(eq(whatsappNumbers.phoneNumberId, phoneNumberId));

  // Not an error: one Meta application serves every client, and a delivery about a number
  // we do not host is simply not ours.
  if (!number) return;

  for (const status of value.statuses ?? []) {
    await db
      .update(messages)
      .set({ status: status.status })
      .where(eq(messages.waMessageId, status.id));
  }

  for (const incoming of value.messages ?? []) {
    const profileName = value.contacts?.find((c) => c.wa_id === incoming.from)?.profile?.name;
    const contactId = await upsertContact(db, number.agentId, incoming.from, profileName);
    const conversationId = await upsertConversation(db, number.agentId, number.id, contactId);

    await storeMessage(db, conversationId, incoming);
    await db
      .update(conversations)
      .set({ lastInboundAt: at(incoming.timestamp), lastMessageAt: at(incoming.timestamp) })
      .where(eq(conversations.id, conversationId));
  }
}

async function upsertContact(
  db: Db,
  agentId: string,
  phone: string,
  name: string | undefined,
): Promise<string> {
  const [created] = await db
    .insert(contacts)
    .values({ agentId, phone, name: name ?? null })
    .onConflictDoUpdate({
      target: [contacts.agentId, contacts.phone],
      // A person who edits their WhatsApp profile should be renamed here too, but a
      // delivery without a name must not erase the one we have.
      set: name ? { name } : { phone },
    })
    .returning({ id: contacts.id });
  return created!.id;
}

async function upsertConversation(
  db: Db,
  agentId: string,
  whatsappNumberId: string,
  contactId: string,
): Promise<string> {
  const [created] = await db
    .insert(conversations)
    .values({ agentId, contactId, whatsappNumberId })
    .onConflictDoUpdate({
      target: [conversations.whatsappNumberId, conversations.contactId],
      set: { contactId },
    })
    .returning({ id: conversations.id });
  return created!.id;
}

async function storeMessage(
  db: Db,
  conversationId: string,
  incoming: InboundMessage,
): Promise<void> {
  await db
    .insert(messages)
    .values({
      conversationId,
      waMessageId: incoming.id,
      direction: 'in',
      author: 'client',
      kind: incoming.type,
      body: bodyOf(incoming),
      sentAt: at(incoming.timestamp),
    })
    // Meta delivers the same message more than once by design. The unique index on
    // wa_message_id is the defence; this clause is how we accept the duplicate quietly.
    .onConflictDoNothing({ target: messages.waMessageId });
}
