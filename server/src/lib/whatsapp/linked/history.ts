import { eq, sql } from 'drizzle-orm';
import { recordReferral } from '../attribution.js';
import type { Db } from '../../../db/client.js';
import { contacts, linkedHistoryMappings, messages, whatsappNumbers } from '../../../db/schema.js';
import {
  advanceConversation,
  isOperatorAlertEcho,
  operatorPhoneOf,
  storeLine,
  upsertContact,
  upsertConversation,
} from '../store.js';
import type { LinkedClient, LinkedEvent, RawLinkedHistory } from './client.js';
import { phoneForLid, rememberLid } from './lid-directory.js';
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
  onImported?: (report: HistoryImportReport & { messages: number; contacts: number; progress: number | null }) => void;
}

export interface HistoryImportReport {
  received: number;
  saved: number;
  duplicates: number;
  excluded: number;
  skippedUnresolved: number;
}

export function registerLinkedHistory(
  db: Db,
  deps: LinkedHistoryDeps,
  client: LinkedClient,
): void {
  client.on((event: LinkedEvent) => {
    if (event.type !== 'history') return;
    if (event.chunk.alreadyStored) return;
    void applyHistoryChunkWithReport(db, event.numberId, event.chunk)
      .then((report) => {
        const { skippedUnresolved } = report;
        if (skippedUnresolved > 0) {
          deps.onError?.(`${skippedUnresolved} history messages were not stored: the contact phone number is unknown`);
        }
        deps.onImported?.({
          messages: event.chunk.messages?.length ?? 0,
          contacts: event.chunk.contacts?.length ?? 0,
          progress: event.chunk.progress ?? null,
          ...report,
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

export async function applyHistoryChunkWithReport(
  db: Db,
  numberId: string,
  chunk: RawLinkedHistory,
): Promise<HistoryImportReport> {
  const received = chunk.messages?.length ?? 0;
  const [number] = await db
    .select()
    .from(whatsappNumbers)
    .where(eq(whatsappNumbers.id, numberId));
  if (!number) return { received, saved: 0, duplicates: 0, excluded: received, skippedUnresolved: 0 };

  const persistedMappings = await db
    .select({ lid: linkedHistoryMappings.lid, phone: linkedHistoryMappings.phone })
    .from(linkedHistoryMappings)
    .where(eq(linkedHistoryMappings.numberId, number.id));
  for (const mapping of persistedMappings) rememberLid(number.id, mapping.lid, mapping.phone);

  const mappings = new Map<string, string>();
  const collectMapping = (phoneJid: string | null | undefined, lidJid: string | null | undefined): void => {
    const phone = jidToPhone(phoneJid);
    const lid = jidToLid(lidJid);
    if (phone && lid) mappings.set(lid, phone);
  };

  for (const mapping of chunk.phoneNumberToLidMappings ?? []) {
    collectMapping(mapping.pnJid, mapping.lidJid);
  }

  // History messages often omit senderPn. Resolve their peer from the accompanying
  // chat/contact metadata before importing either direction; never guess a phone from a LID.
  for (const chat of chunk.chats ?? []) {
    const phone = jidToPhone(chat.pnJid) ?? jidToPhone(chat.id);
    const lid = jidToLid(chat.lidJid) ?? jidToLid(chat.id);
    if (phone && lid) mappings.set(lid, phone);
  }
  for (const contact of chunk.contacts ?? []) {
    const phone = jidToPhone(contact.jid) ?? jidToPhone(contact.id);
    const lid = jidToLid(contact.lid) ?? jidToLid(contact.id);
    if (phone && lid) mappings.set(lid, phone);
  }

  for (const raw of chunk.messages ?? []) {
    if (raw.key?.fromMe === true) continue;
    collectMapping(raw.key?.senderPn, raw.key?.remoteJid);
  }
  for (const [lid, phone] of mappings) {
    rememberLid(number.id, lid, phone);
    await db
      .insert(linkedHistoryMappings)
      .values({ numberId: number.id, lid, phone })
      .onConflictDoUpdate({
        target: [linkedHistoryMappings.numberId, linkedHistoryMappings.lid],
        set: { phone },
      });
  }

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

  const operatorPhone = await operatorPhoneOf(db, number.agentId);
  let skippedUnresolved = 0;
  let saved = 0;
  let duplicates = 0;
  let excluded = 0;
  for (const raw of rawMessages) {
    const line = normalize(raw, number.id);
    if (!line) {
      const lid = raw.message ? jidToLid(raw.key?.remoteJid) : null;
      const unresolved = lid && (raw.key?.fromMe === true
        ? phoneForLid(number.id, lid) === null
        : jidToPhone(raw.key?.senderPn) === null && phoneForLid(number.id, lid) === null);
      if (unresolved) skippedUnresolved += 1;
      else excluded += 1;
      continue;
    }
    // See `isOperatorAlertEcho`: the socket's own handoff alerts come back through here.
    if (await isOperatorAlertEcho(db, number, operatorPhone, line)) {
      excluded += 1;
      continue;
    }

    const contactId = await upsertContact(
      db,
      number.agentId,
      line.from,
      line.fromMe ? undefined : (line.pushName ?? undefined),
    );
    const conversationId = await upsertConversation(db, number.agentId, number.id, contactId);
    if (!line.fromMe && line.referral) await recordReferral(db, conversationId, line.referral);

    const stored = await storeLine(db, conversationId, {
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
    if (stored) saved += 1;
    else duplicates += 1;

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
  return { received, saved, duplicates, excluded, skippedUnresolved };
}
