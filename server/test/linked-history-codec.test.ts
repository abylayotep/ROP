import { expect, it } from 'vitest';
import { proto } from '@whiskeysockets/baileys';
import { decodeHistoryPayload } from '../src/lib/whatsapp/linked/history-codec.js';

it('preserves top-level identity mappings and all conversation messages through raw protobuf storage', () => {
  const payload = proto.HistorySync.encode(proto.HistorySync.fromObject({
    syncType: proto.HistorySync.HistorySyncType.FULL,
    progress: 100,
    phoneNumberToLidMappings: [{ pnJid: '77012345678@s.whatsapp.net', lidJid: '123456@lid' }],
    conversations: [{ id: '123456@lid', messages: [
      { message: { key: { id: 'one', remoteJid: '123456@lid', fromMe: false },
        messageTimestamp: 1789000000, message: { conversation: 'Question' } } },
      { message: { key: { id: 'two', remoteJid: '123456@lid', fromMe: true },
        messageTimestamp: 1789000001, message: { conversation: 'Answer' } } },
    ] }],
  })).finish();
  const result = decodeHistoryPayload(Buffer.from(payload).toString('base64'));
  expect(result.phoneNumberToLidMappings).toEqual([{ pnJid: '77012345678@s.whatsapp.net', lidJid: '123456@lid' }]);
  expect(result.messages.map(message => message.key.id)).toEqual(['one', 'two']);
  expect(result.messages[0]?.messageTimestamp?.valueOf()).toBeDefined();
  expect(result.progress).toBe(100);
});
