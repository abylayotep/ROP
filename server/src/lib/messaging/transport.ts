import { and, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { contacts, conversations, instagramAccounts, instagramContacts, whatsappNumbers } from '../../db/schema.js';
import type { Env } from '../../env.js';
import { ApiError } from '../errors.js';
import type { InstagramMessagingClient } from '../instagram/messaging-graph.js';
import { decryptSecret } from '../secret-box.js';
import type { LinkedClient } from '../whatsapp/linked/client.js';
import { markTokenRejected } from '../whatsapp/token-expiry.js';
import { transportFor, type MessageTransport } from '../whatsapp/transport.js';
import type { GraphClient } from '../whatsapp/graph.js';

export interface ConversationDelivery {
  conversation: typeof conversations.$inferSelect;
  contact: typeof contacts.$inferSelect;
  channel: 'whatsapp' | 'instagram';
  address: string;
  enabled: boolean;
  transport: MessageTransport;
}

export async function deliveryForConversation(
  db: Db, env: Env, deps: { graph: GraphClient; linked: LinkedClient; instagramMessaging: InstagramMessagingClient },
  agentId: string, conversationId: string,
): Promise<ConversationDelivery> {
  const [row] = await db.select({ conversation: conversations, contact: contacts, number: whatsappNumbers,
    instagram: instagramAccounts, instagramContact: instagramContacts })
    .from(conversations).innerJoin(contacts, eq(contacts.id, conversations.contactId))
    .leftJoin(whatsappNumbers, eq(whatsappNumbers.id, conversations.whatsappNumberId))
    .leftJoin(instagramAccounts, eq(instagramAccounts.id, conversations.instagramAccountId))
    .leftJoin(instagramContacts, eq(instagramContacts.contactId, contacts.id))
    .where(and(eq(conversations.id, conversationId), eq(conversations.agentId, agentId)));
  if (!row) throw new ApiError(404, 'Диалог не найден');
  if (row.number) {
    if (!row.contact.phone) throw new ApiError(409, 'У контакта WhatsApp нет номера телефона.');
    return { conversation: row.conversation, contact: row.contact, channel: 'whatsapp', address: row.contact.phone,
      enabled: row.number.enabled,
      transport: transportFor(row.number, { graph: deps.graph, linked: deps.linked,
        key: Buffer.from(env.CREDENTIALS_KEY, 'base64'), onTokenRejected: () => markTokenRejected(db, row.number!.id) }) };
  }
  if (!row.instagram || !row.instagramContact) throw new ApiError(409, 'Канал диалога не подключён.');
  if (row.instagram.tokenExpiresAt && row.instagram.tokenExpiresAt.getTime() <= Date.now()) {
    throw new ApiError(409, 'Доступ Instagram истёк. Подключите аккаунт заново.');
  }
  let token: string;
  try { token = decryptSecret(row.instagram.accessToken, Buffer.from(env.CREDENTIALS_KEY, 'base64'), row.instagram.instagramUserId); }
  catch { throw new ApiError(409, 'Не удалось прочитать доступ Instagram. Подключите его заново.'); }
  const account = row.instagram;
  const recipient = row.instagramContact.instagramUserId;
  return {
    conversation: row.conversation, contact: row.contact, channel: 'instagram', address: recipient,
    enabled: account.enabled && account.subscribedAt !== null,
    transport: {
      requiresOpenWindow: true,
      sendText: async (_to, body) => {
        try { return await deps.instagramMessaging.sendText(account.pageId, token, recipient, body); }
        catch { throw new ApiError(502, 'Meta не отправила сообщение Instagram. Проверьте доступ и подключите аккаунт заново.'); }
      },
      sendMedia: async () => { throw new ApiError(501, 'Отправка файлов в Instagram пока недоступна.'); },
    },
  };
}
