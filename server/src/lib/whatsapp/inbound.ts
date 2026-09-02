import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import {
  contacts,
  conversations,
  messages,
  whatsappEvents,
  whatsappNumbers,
} from '../../db/schema.js';
import { decryptSecret } from '../secret-box.js';
import type { GraphClient } from './graph.js';
import { downloadInboundMedia } from './media.js';

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

/** The referral block Meta attaches to the first message of a click-to-WhatsApp conversation. */
interface Referral {
  source_id?: string;
  source_type?: string;
  headline?: string;
  body?: string;
  ctwa_clid?: string;
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
  referral?: Referral;
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

/** The media id a message carries, if it carries one. */
function mediaIdOf(message: InboundMessage): string | null {
  return (
    message.image?.id ??
    message.audio?.id ??
    message.video?.id ??
    message.document?.id ??
    message.sticker?.id ??
    null
  );
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
      const mediaErrors = await applyPayload(db, deps, event.payload);
      await db
        .update(whatsappEvents)
        .set({ processedAt: new Date(), error: mediaErrors.length ? mediaErrors.join('; ') : null })
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

/** Returns the media download errors collected while applying the payload, if any. */
async function applyPayload(db: Db, deps: InboundDeps, payload: unknown): Promise<string[]> {
  const entries = (payload as { entry?: unknown }).entry;
  if (!Array.isArray(entries)) throw new Error('entry is not an array');

  const errors: string[] = [];
  for (const entry of entries) {
    const changes = (entry as { changes?: unknown }).changes;
    if (!Array.isArray(changes)) throw new Error('changes is not an array');

    for (const change of changes) {
      errors.push(...(await applyChange(db, deps, (change as { value?: ChangeValue }).value ?? {})));
    }
  }
  return errors;
}

/**
 * Records the ad a conversation came from, once.
 *
 * Meta puts `referral` on the first message of a click-to-WhatsApp conversation and never
 * again, and `ctwa_clid` inside it is what stage 6 matches a purchase against — there is no
 * way to look it up afterwards. The `referral_seen_at is null` condition is what makes this
 * write-once: a later ad must not overwrite the one that actually paid for this client.
 *
 * A referral without a click id is still worth keeping: it names the ad for a human reading
 * the conversation, even though Meta cannot attribute a purchase to it.
 */
async function recordReferral(
  db: Db,
  conversationId: string,
  referral: Referral,
): Promise<void> {
  await db
    .update(conversations)
    .set({
      ctwaClid: referral.ctwa_clid ?? null,
      adSourceId: referral.source_id ?? null,
      adSourceType: referral.source_type ?? null,
      adHeadline: referral.headline ?? null,
      adBody: referral.body ?? null,
      referralSeenAt: new Date(),
    })
    .where(and(eq(conversations.id, conversationId), isNull(conversations.referralSeenAt)));
}

/** Returns the media download errors collected while applying this change, if any. */
async function applyChange(db: Db, deps: InboundDeps, value: ChangeValue): Promise<string[]> {
  const phoneNumberId = value.metadata?.phone_number_id;
  if (!phoneNumberId) return [];

  const [number] = await db
    .select()
    .from(whatsappNumbers)
    .where(eq(whatsappNumbers.phoneNumberId, phoneNumberId));

  // Not an error: one Meta application serves every client, and a delivery about a number
  // we do not host is simply not ours.
  if (!number) return [];

  for (const status of value.statuses ?? []) {
    await db
      .update(messages)
      .set({ status: status.status })
      .where(eq(messages.waMessageId, status.id));
  }

  const errors: string[] = [];
  for (const incoming of value.messages ?? []) {
    const profileName = value.contacts?.find((c) => c.wa_id === incoming.from)?.profile?.name;
    const contactId = await upsertContact(db, number.agentId, incoming.from, profileName);
    const conversationId = await upsertConversation(db, number.agentId, number.id, contactId);

    let media: { path: string; mime: string } | null = null;
    const mediaId = mediaIdOf(incoming);
    if (mediaId) {
      try {
        media = await downloadInboundMedia(deps, {
          mediaId,
          token: decryptSecret(number.accessToken, deps.key, number.phoneNumberId),
          agentId: number.agentId,
          waMessageId: incoming.id,
        });
      } catch (error) {
        // The message is still worth having: its caption, its sender and its place in the
        // thread are all real. Only the file is missing, and the event says why.
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }

    await storeMessage(db, conversationId, incoming, media);
    if (incoming.referral) await recordReferral(db, conversationId, incoming.referral);
    await db
      .update(conversations)
      .set({ lastInboundAt: at(incoming.timestamp), lastMessageAt: at(incoming.timestamp) })
      .where(eq(conversations.id, conversationId));
  }
  return errors;
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
  media: { path: string; mime: string } | null,
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
      mediaPath: media?.path ?? null,
      mediaMime: media?.mime ?? null,
    })
    // Meta delivers the same message more than once by design. The unique index on
    // wa_message_id is the defence; this clause is how we accept the duplicate quietly.
    .onConflictDoNothing({ target: messages.waMessageId });
}
