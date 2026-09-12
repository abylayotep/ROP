import { eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { contacts, conversations, messages } from '../../db/schema.js';
import { runTurn, type TurnDeps } from '../ai/turn.js';

/**
 * Writing a conversation down, whichever transport brought it.
 *
 * `inbound.ts` parses Meta's payload shape; this file is everything that happens after the
 * parse, and none of it is Meta's. A linked device produces the same contacts, the same
 * threads and the same rows, so it calls exactly this code rather than a copy of it — one
 * place where `lastInboundAt` moves, one place that decides a message was already stored.
 */

/** Conversation id → agent id, for the turns a delivery earned. */
export type Touched = Map<string, string>;

export interface StoredMedia {
  path: string;
  mime: string;
}

/**
 * One message, in the shape both transports reduce to.
 *
 * `author` carries the distinction the cabinet shows a reader: `client` is the customer,
 * `phone` is the owner answering from their own handset — a line we mirror rather than one
 * we sent.
 */
export interface LineToStore {
  waMessageId: string;
  direction: 'in' | 'out';
  author: 'client' | 'phone';
  /** WhatsApp's own type: text, image, audio, video, document, sticker, unsupported. */
  kind: string;
  body: string | null;
  sentAt: Date;
  /** Outbound only. An inbound line has no delivery status of ours. */
  status?: string | null;
  media?: StoredMedia | null;
  /**
   * Чем скачать файл позже, когда он не скачан сейчас.
   *
   * The history import stores rows and no bytes, so a photo from March exists as a line
   * with no file. This is the WhatsApp message that line was made from, kept so the file
   * can be fetched the first time somebody opens it — and the mime type to show until then.
   */
  pending?: { ref: unknown; mime: string | null } | null;
}

export async function upsertContact(
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

export async function upsertConversation(
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

/**
 * True when this call is the one that stored the message, false when it was already there.
 *
 * Both transports redeliver: Meta by design, a socket by reconnecting mid-stream. The
 * unique index on `wa_message_id` is the defence, and this answer is what tells a first
 * delivery from a repeat — which is what decides whether the agent gets to answer.
 */
export async function storeLine(
  db: Db,
  conversationId: string,
  line: LineToStore,
): Promise<boolean> {
  const stored = await db
    .insert(messages)
    .values({
      conversationId,
      waMessageId: line.waMessageId,
      direction: line.direction,
      author: line.author,
      kind: line.kind,
      body: line.body,
      status: line.status ?? null,
      sentAt: line.sentAt,
      mediaPath: line.media?.path ?? null,
      mediaMime: line.media?.mime ?? line.pending?.mime ?? null,
      mediaRef: line.media ? null : (line.pending?.ref ?? null),
    })
    .onConflictDoNothing({ target: messages.waMessageId })
    // Empty when the conflict fired, which is what makes the answer above trustworthy.
    .returning({ id: messages.id });
  return stored.length > 0;
}

/**
 * Moves a conversation's clocks forward, never back.
 *
 * Both columns only ever grow. Deliveries arrive out of order — Meta redelivers, a socket
 * replays after a reconnect — and `lastInboundAt` going backwards would refuse an operator
 * a reply they are entitled to send, while `lastMessageAt` going backwards would reorder
 * the list under someone who is reading it. Guarded per column rather than in a `where`,
 * because an operator's own reply moves `lastMessageAt` on its own.
 */
export async function advanceConversation(
  db: Db,
  conversationId: string,
  sentAt: Date,
  inbound: boolean,
): Promise<void> {
  // Bound as an ISO string with an explicit cast, not as a Date: a Date inlined into a
  // `sql` fragment reaches Postgres as an untyped parameter and `greatest` cannot be
  // resolved against it, which fails the whole delivery.
  const sentAtParam = sql`${sentAt.toISOString()}::timestamptz`;
  const changes: Record<string, unknown> = {
    lastMessageAt: sql`greatest(coalesce(${conversations.lastMessageAt}, to_timestamp(0)), ${sentAtParam})`,
  };
  if (inbound) {
    changes.lastInboundAt = sql`greatest(coalesce(${conversations.lastInboundAt}, to_timestamp(0)), ${sentAtParam})`;
  }
  await db.update(conversations).set(changes).where(eq(conversations.id, conversationId));
}

/**
 * The operator took this thread by answering from their own phone.
 *
 * Called once, on the pass that actually stored the line. Doing it on a repeat would
 * silence a thread the operator has since switched back on in the cabinet.
 */
export async function silenceAgent(db: Db, conversationId: string): Promise<void> {
  await db
    .update(conversations)
    .set({ aiEnabled: false })
    .where(eq(conversations.id, conversationId));
}

/**
 * The agent's answer to what arrived, one turn per conversation.
 *
 * Nothing here may throw. A turn cannot survive a retry: `unrecorded` means the message
 * reached the customer and only our row failed, so running it again would say the same
 * sentence twice. Hence one turn per stored message, and an outcome is never a reason to
 * fail the delivery that caused it — only a raised error is worth writing down.
 */
export async function runTurns(db: Db, deps: TurnDeps, touched: Touched): Promise<string[]> {
  const errors: string[] = [];
  for (const [conversationId, agentId] of touched) {
    try {
      if (deps.crm && await deps.crm(agentId, conversationId)) continue;
      await runTurn(db, deps, { agentId, conversationId });
    } catch (error) {
      // One conversation's failure must not cost the others theirs: the next entry in the
      // map is somebody else's live thread.
      errors.push(
        `ответ агента не удался: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return errors;
}
