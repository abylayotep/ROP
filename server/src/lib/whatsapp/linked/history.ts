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
import { phoneForLid } from './lid-directory.js';
import { jidToLid, jidToPhone, learnLid, mimeOf, normalize } from './normalize.js';

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
  onImported?: (report: { messages: number; contacts: number; progress: number | null; skippedUnresolved: number }) => void;
}

export function registerLinkedHistory(
  db: Db,
  deps: LinkedHistoryDeps,
  client: LinkedClient,
): void {
  client.on((event: LinkedEvent) => {
    if (event.type !== 'history') return;
    void applyHistoryChunkWithReport(db, event.numberId, event.chunk)
      .then(({ skippedUnresolved }) => {
        if (skippedUnresolved > 0) {
          deps.onError?.(`${skippedUnresolved} history messages were not stored: the contact phone number is unknown`);
        }
        deps.onImported?.({
          messages: event.chunk.messages?.length ?? 0,
          contacts: event.chunk.contacts?.length ?? 0,
          progress: event.chunk.progress ?? null,
          skippedUnresolved,
        });
      })
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
  await applyHistoryChunkWithReport(db, numberId, chunk);
}

async function applyHistoryChunkWithReport(
  db: Db,
  numberId: string,
  chunk: RawLinkedHistory,
): Promise<{ skippedUnresolved: number }> {
  const [number] = await db
    .select()
    .from(whatsappNumbers)
    .where(eq(whatsappNumbers.id, numberId));
  if (!number) return { skippedUnresolved: 0 };

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

  const rawMessages = chunk.messages ?? [];
  // Chunks are not guaranteed chronological: learn every inbound mapping before an older
  // owner reply tries to resolve the same LID.
  for (const raw of rawMessages) learnLid(number.id, raw);

  let skippedUnresolved = 0;
  for (const raw of rawMessages) {
    const line = normalize(raw, number.id);
    if (!line) {
      const lid = raw.message ? jidToLid(raw.key?.remoteJid) : null;
      const unresolved = lid && (raw.key?.fromMe === true
        ? phoneForLid(number.id, lid) === null
        : jidToPhone(raw.key?.senderPn) === null);
      if (unresolved) skippedUnresolved += 1;
      continue;
    }

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

    // History affects ordering only. An old inbound message must not reopen the live reply
    // window; the next real delivery advances `lastInboundAt` through the live pipeline.
    await advanceConversation(db, conversationId, line.sentAt, false);
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
  return { skippedUnresolved };
}
