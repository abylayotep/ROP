import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ConversationSummary, ConversationThread, Message } from '@rakurs/contract';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { aiReplies, contacts, conversations, messages, whatsappNumbers } from '../db/schema.js';
import type { Env } from '../env.js';
import { ApiError } from '../lib/errors.js';
import { credentialsKey } from '../lib/secret-box.js';
import { isUuid } from '../lib/uuid.js';
import type { GraphClient } from '../lib/whatsapp/graph.js';
import type { LinkedClient } from '../lib/whatsapp/linked/client.js';
import { markTokenRejected } from '../lib/whatsapp/token-expiry.js';
import { transportFor } from '../lib/whatsapp/transport.js';
import { storeInboundMedia } from '../lib/whatsapp/media.js';
import { requireAgent } from './require-agent.js';

/** WhatsApp allows a free-form reply for 24 hours after the customer's last message. */
export const WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * One rule, one place. The list, the thread and the send route all have to agree about
 * whether an operator may still write, and three copies of this would eventually disagree.
 */
export const windowOpen = (lastInboundAt: Date | null, now = new Date()): boolean =>
  lastInboundAt !== null && now.getTime() - lastInboundAt.getTime() < WINDOW_MS;

const outgoing = z.object({ body: z.string() });

const toMessage = (row: typeof messages.$inferSelect, aiReplyId: string | null): Message => ({
  id: row.id,
  direction: row.direction,
  author: row.author,
  kind: row.kind,
  body: row.body,
  // A boolean, not a path: the browser learns that a file exists and is given a route to
  // ask for it. Where it sits on our disk is nobody else's business.
  // `mediaRef` counts: an imported history line has its file still on WhatsApp, and the
  // route below fetches it on the first open. Saying «нет файла» would hide a photo the
  // customer did send.
  hasMedia: row.mediaPath !== null || row.mediaRef !== null,
  mediaMime: row.mediaMime,
  status: row.status,
  sentAt: row.sentAt.toISOString(),
  aiReplyId,
});

/** WhatsApp's own document limit: a file the cabinet takes is a file WhatsApp will take. */
const MAX_UPLOAD_BYTES = 16 * 1024 * 1024;

/** What the cabinet calls a file of this type, in the same words an incoming one gets. */
function kindForMime(mime: string): string {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'document';
}

export function registerConversationRoutes(
  app: FastifyInstance,
  db: Db,
  env: Env,
  guard: preHandlerHookHandler,
  graph: GraphClient,
  linked: LinkedClient,
): void {
  const agentGuard = requireAgent(db);

  app.get(
    '/api/agents/:agentId/conversations',
    { preHandler: [guard, agentGuard] },
    async (req): Promise<ConversationSummary[]> => {
      const rows = await db
        .select({
          conversation: conversations,
          contact: contacts,
          preview: sql<string | null>`(
            select m.body from messages m
            where m.conversation_id = ${conversations.id}
            order by m.sent_at desc
            limit 1
          )`,
        })
        .from(conversations)
        .innerJoin(contacts, eq(contacts.id, conversations.contactId))
        .where(eq(conversations.agentId, req.agent!.id))
        .orderBy(sql`${conversations.lastMessageAt} desc nulls last`);

      return rows.map(({ conversation, contact, preview }) => ({
        id: conversation.id,
        contactName: contact.name,
        contactPhone: contact.phone,
        lastMessageAt: conversation.lastMessageAt?.toISOString() ?? null,
        preview,
        windowOpen: windowOpen(conversation.lastInboundAt),
        adHeadline: conversation.adHeadline,
      }));
    },
  );

  app.get(
    '/api/agents/:agentId/conversations/:conversationId',
    { preHandler: [guard, agentGuard] },
    async (req): Promise<ConversationThread> => {
      const { conversationId } = req.params as { conversationId: string };
      const { conversation, contact } = await loadConversation(db, req.agent!.id, conversationId);

      // A left join, not a second query per message: `ai_replies.message_id` points back at
      // the message it produced (at most one row ever does, since a turn stamps it once,
      // when it sends), so one query already carries every message's reply id, if it has
      // one, the same way it already carried everything else about the message.
      const thread = await db
        .select({ message: messages, aiReplyId: aiReplies.id })
        .from(messages)
        .leftJoin(aiReplies, eq(aiReplies.messageId, messages.id))
        .where(eq(messages.conversationId, conversation.id))
        .orderBy(messages.sentAt);

      return {
        id: conversation.id,
        contactName: contact.name,
        contactPhone: contact.phone,
        lastMessageAt: conversation.lastMessageAt?.toISOString() ?? null,
        preview: thread.at(-1)?.message.body ?? null,
        windowOpen: windowOpen(conversation.lastInboundAt),
        adHeadline: conversation.adHeadline,
        aiEnabled: conversation.aiEnabled,
        messages: thread.map((row) => toMessage(row.message, row.aiReplyId)),
      };
    },
  );

  app.post(
    '/api/agents/:agentId/conversations/:conversationId/messages',
    // Any member, not just an owner: answering customers is the job itself.
    { preHandler: [guard, agentGuard] },
    async (req): Promise<Message> => {
      const { conversationId } = req.params as { conversationId: string };

      const parsed = outgoing.safeParse(req.body);
      const body = parsed.success ? parsed.data.body.trim() : '';
      if (!body) throw new ApiError(400, 'Сообщение не может быть пустым');

      const { conversation, contact, number } = await loadConversation(
        db,
        req.agent!.id,
        conversationId,
      );

      if (!number.enabled) {
        throw new ApiError(409, 'Номер отключён. Включите его в интеграциях.');
      }

      // TransportRefusal is an ApiError: its status and Russian sentence reach the
      // operator unchanged, which is the whole reason it carries them.
      const transport = transportFor(number, {
        graph,
        linked,
        key: credentialsKey(env),
        onTokenRejected: () => markTokenRejected(db, number.id),
      });

      // Asked of the transport rather than assumed: the 24-hour window is a Cloud API
      // rule, and a linked device has none. Refused here rather than by Meta so the
      // explanation stays in the operator's language.
      if (transport.requiresOpenWindow && !windowOpen(conversation.lastInboundAt)) {
        throw new ApiError(
          409,
          'Окно ответа закрыто. Клиент должен написать первым, либо нужен шаблон.',
        );
      }

      const { messageId } = await transport.sendText(contact.phone, body);

      // Stored only after Meta accepted it. A row for a message that never left is a lie
      // the operator would act on.
      const sentAt = new Date();
      const [stored] = await db
        .insert(messages)
        .values({
          conversationId: conversation.id,
          waMessageId: messageId,
          direction: 'out',
          author: 'operator',
          kind: 'text',
          body,
          status: 'sent',
          sentAt,
        })
        .returning();

      await db
        .update(conversations)
        .set({ lastMessageAt: sentAt })
        .where(eq(conversations.id, conversation.id));

      // An operator's own line, sent by a person through this very route — never an ai
      // reply, so there is nothing to look up.
      return toMessage(stored!, null);
    },
  );

  /**
   * A file the operator is sending, plus an optional caption.
   *
   * A separate route rather than a content-type branch on the one above: the two share the
   * window rule and nothing else — one validates a string, the other a stream to disk —
   * and folding them together would put two request shapes behind one handler.
   */
  app.post(
    '/api/agents/:agentId/conversations/:conversationId/files',
    { preHandler: [guard, agentGuard] },
    async (req): Promise<Message> => {
      const { conversationId } = req.params as { conversationId: string };

      const file = await req.file({ limits: { fileSize: MAX_UPLOAD_BYTES } });
      if (!file) throw new ApiError(400, 'Файл не выбран');
      const caption = (file.fields?.caption as { value?: string } | undefined)?.value?.trim() ?? '';

      const { conversation, contact, number } = await loadConversation(
        db,
        req.agent!.id,
        conversationId,
      );

      if (!number.enabled) {
        throw new ApiError(409, 'Номер отключён. Включите его в интеграциях.');
      }

      const transport = transportFor(number, {
        graph,
        linked,
        key: credentialsKey(env),
        onTokenRejected: () => markTokenRejected(db, number.id),
      });
      if (transport.requiresOpenWindow && !windowOpen(conversation.lastInboundAt)) {
        throw new ApiError(
          409,
          'Окно ответа закрыто. Клиент должен написать первым, либо нужен шаблон.',
        );
      }

      const bytes = await file.toBuffer().catch(() => {
        throw new ApiError(413, `Файл больше ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} МБ.`);
      });
      if (file.file.truncated) {
        throw new ApiError(413, `Файл больше ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} МБ.`);
      }

      // Written before the send, and under a name of our own: the cabinet has to be able
      // to show what it sent, and the media route already serves files by message id. The
      // placeholder id is replaced below by the one WhatsApp answers with.
      const mime = file.mimetype || 'application/octet-stream';
      const placeholder = `out.${randomUUID()}`;
      const stored = await storeInboundMedia(
        { mediaDir: env.MEDIA_DIR },
        { bytes, mime, agentId: req.agent!.id, waMessageId: placeholder },
      );

      const { messageId } = await transport.sendMedia(contact.phone, {
        path: join(env.MEDIA_DIR, stored.path),
        mime,
        filename: file.filename,
        caption: caption || undefined,
      });

      const sentAt = new Date();
      const [row] = await db
        .insert(messages)
        .values({
          conversationId: conversation.id,
          waMessageId: messageId,
          direction: 'out',
          author: 'operator',
          kind: kindForMime(mime),
          body: caption || null,
          status: 'sent',
          sentAt,
          mediaPath: stored.path,
          mediaMime: mime,
        })
        .returning();

      await db
        .update(conversations)
        .set({ lastMessageAt: sentAt })
        .where(eq(conversations.id, conversation.id));

      return toMessage(row!, null);
    },
  );

  app.get(
    '/api/agents/:agentId/messages/:messageId/media',
    { preHandler: [guard, agentGuard] },
    async (req, reply) => {
      const { messageId } = req.params as { messageId: string };

      // The id comes from the URL. Comparing non-UUID text against a uuid column makes
      // Postgres raise, which would turn a typo into a 500 instead of the 404 below.
      if (!isUuid(messageId)) throw new ApiError(404, 'Файл не найден');

      const [row] = await db
        .select({ message: messages })
        .from(messages)
        .innerJoin(conversations, eq(conversations.id, messages.conversationId))
        .where(and(eq(messages.id, messageId), eq(conversations.agentId, req.agent!.id)));

      if (!row) throw new ApiError(404, 'Файл не найден');

      // Imported history holds the message but not its bytes. The download happens here,
      // the first time somebody opens the file, and the row is filled in afterwards so the
      // second open is a disk read like any other.
      const message = row.message.mediaPath
        ? row.message
        : await fetchPendingMedia(db, env, linked, row.message);

      if (!message.mediaPath) throw new ApiError(404, 'Файл не найден');

      // The only path ever used is the one stored on the row. A path from the request
      // would be a way to read any file the process can reach.
      const file = await readFile(join(env.MEDIA_DIR, message.mediaPath)).catch(() => null);
      if (!file) throw new ApiError(404, 'Файл не найден');

      return reply.type(message.mediaMime ?? 'application/octet-stream').send(file);
    },
  );
}

/**
 * Файл, который история принесла ссылкой, а не байтами.
 *
 * The phone is asked for it now, once, and the answer is written to the row: `mediaRef` is
 * cleared, so a second open is a disk read and a photo does not cost a WhatsApp download
 * every time somebody scrolls past it. A failure leaves the row alone — the file may be a
 * reconnect away — and answers 404, the same as a file that was never there.
 */
async function fetchPendingMedia(
  db: Db,
  env: Env,
  linked: LinkedClient,
  message: typeof messages.$inferSelect,
): Promise<typeof messages.$inferSelect> {
  if (!message.mediaRef) return message;

  const [row] = await db
    .select({ number: whatsappNumbers })
    .from(conversations)
    .innerJoin(whatsappNumbers, eq(whatsappNumbers.id, conversations.whatsappNumberId))
    .where(eq(conversations.id, message.conversationId));

  // Only a linked phone can be asked: a Cloud API file is fetched when it arrives, and its
  // id stops working after thirty days, so there is nothing here to ask Meta for.
  const number = row?.number;
  if (!number || number.connectionKind !== 'linked') return message;

  try {
    const bytes = await linked.downloadMedia(number.id, message.mediaRef as never);
    const stored = await storeInboundMedia(
      { mediaDir: env.MEDIA_DIR },
      {
        bytes,
        mime: message.mediaMime ?? 'application/octet-stream',
        agentId: number.agentId,
        waMessageId: message.waMessageId ?? message.id,
      },
    );

    const [updated] = await db
      .update(messages)
      .set({ mediaPath: stored.path, mediaMime: stored.mime, mediaRef: null })
      .where(eq(messages.id, message.id))
      .returning();
    return updated ?? message;
  } catch {
    // The phone is off, or WhatsApp no longer holds the file. Both read the same to the
    // person clicking: «файла нет». The row keeps its reference for the next attempt.
    return message;
  }
}

/** The conversation with everything the routes need, or a 404 that says nothing more. */
async function loadConversation(db: Db, agentId: string, conversationId: string) {
  if (!isUuid(conversationId)) throw new ApiError(404, 'Диалог не найден');

  const [row] = await db
    .select({ conversation: conversations, contact: contacts, number: whatsappNumbers })
    .from(conversations)
    .innerJoin(contacts, eq(contacts.id, conversations.contactId))
    .innerJoin(whatsappNumbers, eq(whatsappNumbers.id, conversations.whatsappNumberId))
    .where(and(eq(conversations.id, conversationId), eq(conversations.agentId, agentId)));

  if (!row) throw new ApiError(404, 'Диалог не найден');
  return row;
}
