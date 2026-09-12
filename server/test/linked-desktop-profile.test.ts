import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({
  makeWASocket: vi.fn((_options: Record<string, unknown>) => ({
    ev: { on: vi.fn((_name: string, _callback: (...args: never[]) => void) => undefined) },
  })),
}));

vi.mock('@whiskeysockets/baileys', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@whiskeysockets/baileys')>()),
  default: mocked.makeWASocket,
}));

vi.mock('../src/lib/whatsapp/linked/auth-state.js', () => ({
  linkedAuthState: vi.fn(async () => ({
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
  beforeEach(() => mocked.makeWASocket.mockClear());

  it('requests history without advertising the rejected native desktop protocol', async () => {
    const createSession = createLinkedSocket({} as Db, Buffer.alloc(32));

    await createSession('00000000-0000-0000-0000-000000000001', () => undefined);

    const options = mocked.makeWASocket.mock.calls[0]?.[0];
    const payload = generateLoginNode('15551234567:1@s.whatsapp.net', {
      ...options, version: [2, 3000, 1], countryCode: 'US',
    } as never);
    expect(payload.webInfo?.webSubPlatform).toBe(proto.ClientPayload.WebInfo.WebSubPlatform.WEB_BROWSER);
    expect(options?.syncFullHistory).toBe(true);
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
});
