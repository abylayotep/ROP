import { eq } from 'drizzle-orm';
import type { Db } from '../../../db/client.js';
import { messages, whatsappNumbers } from '../../../db/schema.js';
import type { TurnDeps } from '../../ai/turn.js';
import { storeInboundMedia } from '../media.js';
import {
  advanceConversation,
  runTurns,
  silenceAgent,
  storeLine,
  upsertContact,
  upsertConversation,
  type StoredMedia,
} from '../store.js';
import type { LinkedClient, LinkedEvent, RawLinkedMessage } from './client.js';
import { jidToLid, mimeOf, normalize } from './normalize.js';

/**
 * What arrives on a linked device's socket, written down.
 *
 * The Cloud API path stores a delivery first and parses it afterwards, because Meta retries
 * anything it is not answered `200` for and parsing before answering would lose a message
 * to any bug of ours. A socket has no such contract: there is no delivery to store and no
 * retry to earn, so this writes directly and takes responsibility for not throwing.
 */

export interface LinkedInboundDeps extends TurnDeps {
  mediaDir: string;
  /** Where a failure goes. The socket has no event row to write it on. */
  onError?: (message: string) => void;
}

export function registerLinkedInbound(
  db: Db,
  deps: LinkedInboundDeps,
  client: LinkedClient,
): void {
  client.on((event: LinkedEvent) => {
    if (event.type !== 'message') return;
    // Fire and forget by design: the socket's event loop must not wait on our database, and
    // there is nothing upstream that would do anything useful with a rejected promise.
    void applyMessage(db, deps, client, event.numberId, event.message).catch((error) => {
      deps.onError?.(error instanceof Error ? error.message : String(error));
    });
  });
}

/**
 * The one dropped message worth a line in the log.
 *
 * `normalize` refuses groups, status broadcasts and protocol traffic by the hundred, and
 * saying so would bury the log in things working as intended. A one-to-one chat WhatsApp
 * addressed by LID is the opposite: a customer wrote, the socket decrypted it, and the
 * cabinet has no number to file it under. That silence is what made this class of bug
 * invisible for a whole day, so it ends here.
 */
function reportDropped(deps: LinkedInboundDeps, raw: RawLinkedMessage): void {
  if (!raw.message) return;
  const lid = jidToLid(raw.key?.remoteJid);
  if (!lid) return;
  deps.onError?.(
    `сообщение ${raw.key?.id ?? '?'} из чата ${lid}@lid не записано: номер собеседника неизвестен`,
  );
}

export async function applyMessage(
  db: Db,
  deps: LinkedInboundDeps,
  client: LinkedClient,
  numberId: string,
  raw: RawLinkedMessage,
): Promise<void> {
  const line = normalize(raw);
  if (!line) {
    reportDropped(deps, raw);
    return;
  }

  const [number] = await db
    .select()
    .from(whatsappNumbers)
    .where(eq(whatsappNumbers.id, numberId));
  // The socket outlived its row: the number was deleted while the phone was still connected.
  if (!number) return;

  const contactId = await upsertContact(
    db,
    number.agentId,
    line.from,
    // A name the cabinet already has outranks the phone's, and `upsertContact` only fills a
    // null. The owner's own outgoing line carries their name, not the customer's, so it is
    // never allowed to name the contact.
    line.fromMe ? undefined : (line.pushName ?? undefined),
  );
  const conversationId = await upsertConversation(db, number.agentId, number.id, contactId);

  // A socket replays after a reconnect, so the same message arrives more than once. The
  // insert below would drop the duplicate anyway; asking first is what stops us downloading
  // its file a second time, which is a full transfer for bytes already on disk.
  const [known] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.waMessageId, line.waMessageId));

  let media: StoredMedia | null = null;
  if (line.hasMedia && !known) {
    try {
      const bytes = await client.downloadMedia(numberId, raw);
      media = await storeInboundMedia(deps, {
        bytes,
        mime: mimeOf(raw) ?? 'application/octet-stream',
        agentId: number.agentId,
        waMessageId: line.waMessageId,
      });
    } catch (error) {
      // The message is still worth having: its caption, its sender and its place in the
      // thread are all real. Only the file is missing.
      deps.onError?.(
        `файл сообщения ${line.waMessageId} не скачался: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const stored =
    !known &&
    (await storeLine(db, conversationId, {
      waMessageId: line.waMessageId,
      direction: line.fromMe ? 'out' : 'in',
      author: line.fromMe ? 'phone' : 'client',
      kind: line.kind,
      body: line.body,
      status: line.fromMe ? 'sent' : null,
      sentAt: line.sentAt,
      media,
    }));

  await advanceConversation(db, conversationId, line.sentAt, !line.fromMe);

  if (line.fromMe) {
    // The owner answered from their handset. Switching the agent off is them taking the
    // thread, and it happens once — on the pass that stored the line — so a replay does not
    // silence a thread they have since switched back on in the cabinet.
    if (stored) await silenceAgent(db, conversationId);
    return;
  }

  // Only a line this pass actually stored earns an answer. A replayed message has already
  // been answered, and answering it again would say the same sentence to the customer twice.
  if (stored) {
    await runTurns(db, deps, new Map([[conversationId, number.agentId]]));
  }
}
