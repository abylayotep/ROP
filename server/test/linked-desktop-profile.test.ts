import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({
  expectedPhone: undefined as string | undefined,
  makeWASocket: vi.fn((_options: Record<string, unknown>) => ({
    ev: { on: vi.fn((_name: string, _callback: (...args: never[]) => void) => undefined) },
    logout: vi.fn(async () => undefined),
  })),
}));

vi.mock('@whiskeysockets/baileys', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@whiskeysockets/baileys')>()),
  default: mocked.makeWASocket,
}));

vi.mock('../src/lib/whatsapp/linked/auth-state.js', () => ({
  linkedAuthState: vi.fn(async () => ({
    expectedPhone: mocked.expectedPhone,
    state: {
      creds: {},
      keys: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => undefined),
      },
    },
    saveCreds: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined),
  })),
}));

import type { Db } from '../src/db/client.js';
import { generateLoginNode, proto } from '@whiskeysockets/baileys';
import { createLinkedSocket } from '../src/lib/whatsapp/linked/socket.js';

describe('linked WhatsApp desktop profile', () => {
  beforeEach(() => { mocked.makeWASocket.mockClear(); mocked.expectedPhone = undefined; });

  it('captures raw history notifications and suppresses the lossy processed import when archiving is enabled', async () => {
    const captured: string[] = [];
    const events: unknown[] = [];
    await createLinkedSocket({} as Db, Buffer.alloc(32), {
      capture: async (_numberId, notification) => { captured.push(notification); },
      onError: () => undefined,
    })('number', event => events.push(event));
    const options = mocked.makeWASocket.mock.calls[0]![0];
    const shouldSync = options.shouldSyncHistoryMessage as (notification: unknown) => boolean;
    expect(typeof shouldSync).toBe('function');
    expect(shouldSync({ syncType: 3 })).toBe(true);
    expect(captured).toHaveLength(0);
    expect(shouldSync({ syncType: 3, directPath: '/history', mediaKey: Buffer.alloc(32, 1) })).toBe(true);
    await Promise.resolve();
    expect(captured).toHaveLength(1);
    expect(proto.Message.HistorySyncNotification.decode(Buffer.from(captured[0]!, 'base64')).directPath).toBe('/history');
    const socket = mocked.makeWASocket.mock.results[0]!.value;
    const callback = socket.ev.on.mock.calls.find((args: unknown[]) => args[0] === 'messaging-history.set')?.[1] as unknown as (value: unknown) => void;
    callback({ messages: [{ key: { id: 'lossy' } }], contacts: [] });
    expect(events).toEqual([]);
  });

  it('rejects a different phone before accepting messages into existing history', async () => {
    mocked.expectedPhone = '15551234567';
    const events: unknown[] = [];
    await createLinkedSocket({} as Db, Buffer.alloc(32))('number', event => events.push(event));
    const socket = mocked.makeWASocket.mock.results[0]!.value;
    Object.assign(socket, { user: { id: '15559876543:1@s.whatsapp.net' } });
    const callback = socket.ev.on.mock.calls.find((args: unknown[]) => args[0] === 'connection.update')?.[1] as unknown as (value: unknown) => void;
    callback({ connection: 'open' });
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'open' }));
    expect(socket.logout).toHaveBeenCalledOnce();
  });

  it('requests history without advertising the rejected native desktop protocol', async () => {
    const createSession = createLinkedSocket({} as Db, Buffer.alloc(32));

    await createSession('00000000-0000-0000-0000-000000000001', () => undefined);

    const options = mocked.makeWASocket.mock.calls[0]?.[0];
    const payload = generateLoginNode('15551234567:1@s.whatsapp.net', {
      ...options, version: [2, 3000, 1], countryCode: 'US',
    } as never);
    expect(payload.webInfo?.webSubPlatform).toBe(proto.ClientPayload.WebInfo.WebSubPlatform.WEB_BROWSER);
    expect(options?.syncFullHistory).toBe(false);
  });

  it('exposes only the numeric disconnect reason to the lifecycle', async () => {
    const events: unknown[] = [];
    await createLinkedSocket({} as Db, Buffer.alloc(32))('number', event => events.push(event));
    const socket = mocked.makeWASocket.mock.results[0]!.value;
    const callback = socket.ev.on.mock.calls.find((args: unknown[]) => args[0] === 'connection.update')?.[1] as unknown as (value: unknown) => void;
    callback({ connection: 'close', lastDisconnect: { error: {
      output: { statusCode: 405 }, message: 'private upstream details',
    } } });
    expect(events).toEqual([{ type: 'closed', numberId: 'number', loggedOut: false, statusCode: 405 }]);
  });

  it('routes appended messages through history without triggering live replies', async () => {
    const events: unknown[] = [];
    await createLinkedSocket({} as Db, Buffer.alloc(32))('number', event => events.push(event));
    const socket = mocked.makeWASocket.mock.results[0]!.value;
    const callback = socket.ev.on.mock.calls.find((args: unknown[]) => args[0] === 'messages.upsert')?.[1] as unknown as (value: unknown) => void;
    const messages = [{ key: { id: 'old', remoteJid: '15551234567@s.whatsapp.net', fromMe: false },
      message: { conversation: 'Existing customer message' }, messageTimestamp: 1700000000 }];
    callback({ type: 'append', messages });
    expect(events).toEqual([{ type: 'history', numberId: 'number', chunk: { messages, contacts: [] } }]);
  });

  it('keeps new notifications on the live message path', async () => {
    const events: unknown[] = [];
    await createLinkedSocket({} as Db, Buffer.alloc(32))('number', event => events.push(event));
    const socket = mocked.makeWASocket.mock.results[0]!.value;
    const callback = socket.ev.on.mock.calls.find((args: unknown[]) => args[0] === 'messages.upsert')?.[1] as unknown as (value: unknown) => void;
    const message = { key: { id: 'new' }, message: { conversation: 'New message' } };
    callback({ type: 'notify', messages: [message] });
    expect(events).toEqual([{ type: 'message', numberId: 'number', message }]);
  });
});
