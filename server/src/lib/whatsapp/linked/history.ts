import { eq, sql } from 'drizzle-orm';
import type { Db } from '../../../db/client.js';
import { contacts, messages, whatsappNumbers } from '../../../db/schema.js';
import {
  advanceConversation,
  storeLine,
  upsertContact,
  upsertConversation,
} from '../store.js';
import type { LinkedClient, LinkedEvent, RawLinkedHistory } from './client.js';
import { jidToPhone, mimeOf, normalize } from './normalize.js';

/**
 * The chats already on the phone, brought in after pairing.
 *
 * Two things separate this from the live pipeline, and they are the whole file:
 *
 * - **No turn is ever run.** A question from four months ago does not want an answer
 *   today, and a shop that paired its phone on Monday must not spend Monday evening
 *   replying to everyone who ever wrote to it.
 * - **No file is downloaded.** Months of photos at pairing time is a long wait for bytes
 *   most conversations will never be scrolled back to. The row keeps the message and the
 *   keys needed to fetch its file, and the media route downloads it the first time someone
 *   opens it.
 */

export interface LinkedHistoryDeps {
  onError?: (message: string) => void;
  /**
   * Called once per chunk the phone sent and the cabinet stored.
   *
   * The import is otherwise invisible: it runs minutes after a pairing, writes rows nobody
   * is watching, and when the phone sends nothing at all the result looks exactly like a
   * bug in this file. A line per chunk is what tells the two apart.
   */
  onImported?: (report: { messages: number; contacts: number; progress: number | null }) => void;
}

export function registerLinkedHistory(
  db: Db,
  deps: LinkedHistoryDeps,
  client: LinkedClient,
): void {
  client.on((event: LinkedEvent) => {
    if (event.type !== 'history') return;
    void applyHistoryChunk(db, event.numberId, event.chunk)
      .then(() =>
        deps.onImported?.({
          messages: event.chunk.messages?.length ?? 0,
          contacts: event.chunk.contacts?.length ?? 0,
          progress: event.chunk.progress ?? null,
        }),
      )
      .catch((error: unknown) => {
        deps.onError?.(error instanceof Error ? error.message : String(error));
      });
  });
}

export async function applyHistoryChunk(
  db: Db,
  numberId: string,
  chunk: RawLinkedHistory,
): Promise<void> {
  const [number] = await db
    .select()
    .from(whatsappNumbers)
    .where(eq(whatsappNumbers.id, numberId));
  if (!number) return;

  for (const entry of chunk.contacts ?? []) {
    const phone = jidToPhone(entry.id);
    if (!phone) continue;
    const name = entry.name ?? entry.notify ?? null;
    if (!name) continue;

    // Only where the cabinet has nothing. A name typed by the owner in the cabinet
    // outranks the phone's address book, and an import must not overwrite it.
    await db
      .insert(contacts)
      .values({ agentId: number.agentId, phone, name })
      .onConflictDoUpdate({
        target: [contacts.agentId, contacts.phone],
        set: { name: sql`coalesce(${contacts.name}, excluded.name)` },
      });
  }

  for (const raw of chunk.messages ?? []) {
    const line = normalize(raw);
    if (!line) continue;

    const contactId = await upsertContact(
      db,
      number.agentId,
      line.from,
      line.fromMe ? undefined : (line.pushName ?? undefined),
    );
    const conversationId = await upsertConversation(db, number.agentId, number.id, contactId);

    await storeLine(db, conversationId, {
      waMessageId: line.waMessageId,
      direction: line.fromMe ? 'out' : 'in',
      author: line.fromMe ? 'phone' : 'client',
      kind: line.kind,
      body: line.body,
      status: line.fromMe ? 'sent' : null,
      sentAt: line.sentAt,
      // Deliberately absent. See the file's own comment — the file itself is fetched on
      // the first open, from the message kept here beside the row.
      media: null,
      pending: line.hasMedia ? { ref: { key: raw.key, message: raw.message }, mime: mimeOf(raw) } : null,
    });

    await advanceConversation(db, conversationId, line.sentAt, !line.fromMe);
  }

  if (typeof chunk.progress === 'number') {
    await db
      .update(whatsappNumbers)
      // Only ever forward: chunks arrive out of order and a percentage that went backwards
      // would read as an import that had started again.
      .set({
        historyProgress: sql`greatest(${whatsappNumbers.historyProgress}, ${chunk.progress})`,
      })
      .where(eq(whatsappNumbers.id, numberId));
  }
}
