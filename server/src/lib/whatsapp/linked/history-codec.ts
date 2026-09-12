import { downloadHistory, processHistoryMessage, proto } from '@whiskeysockets/baileys';
import type { RawLinkedHistory } from './client.js';

/** Keep the original protobuf, including fields omitted by Baileys' processed event. */
export function decodeHistoryPayload(payload: string, notification?: string): RawLinkedHistory {
  const raw = proto.HistorySync.decode(Buffer.from(payload, 'base64'));
  const mappings = raw.phoneNumberToLidMappings.map(pair => ({ pnJid: pair.pnJid, lidJid: pair.lidJid }));
  const result = processHistoryMessage(raw);
  return {
    messages: result.messages as unknown as RawLinkedHistory['messages'],
    contacts: result.contacts,
    chats: result.chats.map(chat => ({ id: chat.id, pnJid: chat.pnJid, lidJid: chat.lidJid })),
    phoneNumberToLidMappings: mappings,
    progress: raw.progress,
    peerDataRequestSessionId: notification
      ? proto.Message.HistorySyncNotification.decode(Buffer.from(notification, 'base64')).peerDataRequestSessionId : null,
  };
}

export async function downloadHistoryPayload(notification: string): Promise<string> {
  const decoded = proto.Message.HistorySyncNotification.decode(Buffer.from(notification, 'base64'));
  const history = await downloadHistory(decoded, { timeout: 60_000, maxContentLength: 64 * 1024 * 1024 });
  const bytes = proto.HistorySync.encode(history).finish();
  if (bytes.length > 64 * 1024 * 1024) throw new Error('History packet exceeds storage limit');
  return Buffer.from(bytes).toString('base64');
}
