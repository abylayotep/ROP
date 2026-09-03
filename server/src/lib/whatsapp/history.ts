import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { contacts, conversations, messages, whatsappNumbers } from '../../db/schema.js';
import { decryptSecret } from '../secret-box.js';
import { withoutSecret } from './graph.js';
import type { InboundDeps } from './inbound.js';
import { downloadInboundMedia } from './media.js';

/** Meta's error code for «the business turned history sharing off on the phone». */
const HISTORY_DECLINED = 2593109;
/** Rows per insert. A chunk can describe thousands of messages; one statement each is slow. */
const BATCH = 500;

interface HistoryMessage {
  from: string;
  to?: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  image?: { id?: string; caption?: string };
  audio?: { id?: string };
  video?: { id?: string; caption?: string };
  document?: { id?: string; caption?: string; filename?: string };
  sticker?: { id?: string };
  history_context?: { status?: string };
}

/**
 * The media id a history message carries, if it carries one.
 *
 * A first chunk describes a file as `media_placeholder` — the phone had not uploaded it yet.
 * A later chunk repeats the same `id` with the real sub-object, and that is the only moment
 * the bytes can be fetched.
 */
function mediaIdOf(m: HistoryMessage): string | null {
  return m.image?.id ?? m.audio?.id ?? m.video?.id ?? m.document?.id ?? m.sticker?.id ?? null;
}

interface HistoryChunk {
  metadata?: { phase?: number; chunk_order?: number; progress?: number };
  threads?: { id: string; messages?: HistoryMessage[] }[];
  errors?: { code?: number; message?: string }[];
}

export interface HistoryValue {
  metadata?: { phone_number_id?: string; display_phone_number?: string };
  history?: HistoryChunk[];
}

type NumberRow = typeof whatsappNumbers.$inferSelect;

const digits = (s: string) => s.replace(/\D/g, '');
const at = (timestamp: string) => new Date(Number(timestamp) * 1000);

/** Threads are keyed by the customer's number. A group id carries `@g.us` and is not one. */
const isPhone = (id: string) => /^\d{7,15}$/.test(id);

function bodyOf(m: HistoryMessage): string | null {
  switch (m.type) {
    case 'text':
      return m.text?.body ?? null;
    case 'image':
      return m.image?.caption ?? null;
    case 'video':
      return m.video?.caption ?? null;
    case 'document':
      return m.document?.caption ?? m.document?.filename ?? null;
    case 'media_placeholder':
      return 'Файл из истории телефона';
    default:
      return null;
  }
}

/**
 * One `history` webhook: up to 180 days of the phone's chats, in chunks that may arrive in
 * any order and more than once.
 *
 * Everything written here is idempotent — the unique index on `wa_message_id` drops a
 * repeat, the upserts are conflict-safe, the timestamps only move forward — which is what
 * makes order and redelivery irrelevant. Imported messages move `last_message_at` so the
 * thread sorts where it belongs, and never `last_inbound_at`: an old message opens no reply
 * window, wakes no agent and enters no funnel. The customer's next real message does all of
 * that in the usual way.
 */
export async function applyHistory(
  db: Db,
  deps: InboundDeps,
  number: NumberRow,
  value: HistoryValue,
): Promise<{ errors: string[] }> {
  const errors: string[] = [];
  let progress = number.historyProgress;

  for (const chunk of value.history ?? []) {
    if (chunk.errors?.some((e) => e.code === HISTORY_DECLINED)) {
      await db
        .update(whatsappNumbers)
        .set({ historyDeclinedAt: sql`coalesce(${whatsappNumbers.historyDeclinedAt}, now())` })
        .where(eq(whatsappNumbers.id, number.id));
      continue;
    }
    progress = Math.max(progress, chunk.metadata?.progress ?? 0);

    for (const thread of chunk.threads ?? []) {
      const phone = digits(thread.id);
      if (!isPhone(phone)) continue;
      const list = thread.messages ?? [];
      if (list.length === 0) continue;

      const [contact] = await db
        .insert(contacts)
        .values({ agentId: number.agentId, phone })
        .onConflictDoUpdate({ target: [contacts.agentId, contacts.phone], set: { phone } })
        .returning({ id: contacts.id });
      const [conversation] = await db
        .insert(conversations)
        .values({ agentId: number.agentId, contactId: contact!.id, whatsappNumberId: number.id })
        .onConflictDoUpdate({
          target: [conversations.whatsappNumberId, conversations.contactId],
          set: { contactId: contact!.id },
        })
        .returning({ id: conversations.id });

      const business = digits(number.displayPhone);
      let latest = 0;
      for (let i = 0; i < list.length; i += BATCH) {
        const rows = list.slice(i, i + BATCH).map((m) => {
          const outbound = digits(m.from) === business;
          const sentAt = at(m.timestamp);
          latest = Math.max(latest, sentAt.getTime());
          return {
            conversationId: conversation!.id,
            waMessageId: m.id,
            direction: outbound ? 'out' : 'in',
            author: outbound ? 'phone' : 'client',
            kind: m.type === 'media_placeholder' ? 'unsupported' : m.type,
            body: bodyOf(m),
            status: outbound ? (m.history_context?.status?.toLowerCase() ?? null) : null,
            sentAt,
          };
        });
        await db.insert(messages).values(rows).onConflictDoNothing({ target: messages.waMessageId });
      }

      // A chunk that carries the real media for a placeholder stored earlier. The insert
      // above cannot do it: the row already exists and the conflict drops the repeat.
      for (const m of list) {
        const mediaId = mediaIdOf(m);
        if (!mediaId) continue;
        const [placeholder] = await db
          .select({ id: messages.id })
          .from(messages)
          .where(
            and(
              eq(messages.waMessageId, m.id),
              eq(messages.kind, 'unsupported'),
              isNull(messages.mediaPath),
            ),
          );
        if (!placeholder) continue;
        let token = '';
        try {
          token = decryptSecret(number.accessToken, deps.key, number.phoneNumberId);
          const media = await downloadInboundMedia(deps, {
            mediaId,
            token,
            agentId: number.agentId,
            waMessageId: m.id,
          });
          await db
            .update(messages)
            .set({
              kind: m.type,
              body: bodyOf(m),
              mediaPath: media.path,
              mediaMime: media.mime,
            })
            .where(eq(messages.id, placeholder.id));
        } catch (error) {
          // The placeholder stays as it is and says so; only the file is missing.
          errors.push(withoutSecret(error instanceof Error ? error.message : String(error), token));
        }
      }

      if (latest > 0) {
        const latestParam = sql`${new Date(latest).toISOString()}::timestamptz`;
        await db
          .update(conversations)
          .set({
            lastMessageAt: sql`greatest(coalesce(${conversations.lastMessageAt}, to_timestamp(0)), ${latestParam})`,
          })
          .where(eq(conversations.id, conversation!.id));
      }
    }
  }

  if (progress > number.historyProgress) {
    await db
      .update(whatsappNumbers)
      .set({ historyProgress: sql`greatest(${whatsappNumbers.historyProgress}, ${progress})` })
      .where(eq(whatsappNumbers.id, number.id));
  }
  return { errors };
}
