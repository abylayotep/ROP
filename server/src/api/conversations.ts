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
import { credentialsKey, decryptSecret } from '../lib/secret-box.js';
import { isUuid } from '../lib/uuid.js';
import { GraphError, withoutSecret, type GraphClient } from '../lib/whatsapp/graph.js';
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
  hasMedia: row.mediaPath !== null,
  mediaMime: row.mediaMime,
  status: row.status,
  sentAt: row.sentAt.toISOString(),
  aiReplyId,
});

export function registerConversationRoutes(
  app: FastifyInstance,
  db: Db,
  env: Env,
  guard: preHandlerHookHandler,
  graph: GraphClient,
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
      if (!windowOpen(conversation.lastInboundAt)) {
        // Refused here rather than by Meta: the explanation stays in the operator's
        // language, and a request nobody can satisfy is not worth sending.
        throw new ApiError(
          409,
          'Окно ответа закрыто. Клиент должен написать первым, либо нужен шаблон.',
        );
      }

      // A key that no longer matches the stored token throws an English developer message.
      // The frontend renders `message` verbatim, so it is answered here in the operator's
      // language, with the one thing they can do about it.
      let token: string;
      try {
        token = decryptSecret(number.accessToken, credentialsKey(env), number.phoneNumberId);
      } catch {
        throw new ApiError(
          409,
          'Не удалось прочитать токен номера. Подключите номер заново в интеграциях.',
        );
      }

      let messageId: string;
      try {
        ({ messageId } = await graph.sendText(number.phoneNumberId, token, contact.phone, body));
      } catch (error) {
        if (error instanceof GraphError) {
          throw new ApiError(502, `Meta не отправила сообщение: ${withoutSecret(error.message, token)}`);
        }
        throw error;
      }

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

      if (!row?.message.mediaPath) throw new ApiError(404, 'Файл не найден');

      // The only path ever used is the one stored on the row. A path from the request
      // would be a way to read any file the process can reach.
      const file = await readFile(join(env.MEDIA_DIR, row.message.mediaPath)).catch(() => null);
      if (!file) throw new ApiError(404, 'Файл не найден');

      return reply.type(row.message.mediaMime ?? 'application/octet-stream').send(file);
    },
  );
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
