import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({
  makeWASocket: vi.fn((_options: Record<string, unknown>) => ({
    ev: { on: vi.fn() },
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
import { createLinkedSocket } from '../src/lib/whatsapp/linked/socket.js';

describe('linked WhatsApp desktop profile', () => {
  beforeEach(() => mocked.makeWASocket.mockClear());

  it('uses a Baileys-recognized desktop OS when requesting full history', async () => {
    const createSession = createLinkedSocket({} as Db, Buffer.alloc(32));

    await createSession('00000000-0000-0000-0000-000000000001', () => undefined);

    const options = mocked.makeWASocket.mock.calls[0]?.[0];
    const browser = options?.browser as unknown[] | undefined;
    expect(browser?.[0]).toBe('Mac OS');
    expect(browser?.[1]).toBe('Ракурс');
    expect(options?.syncFullHistory).toBe(true);
  });
});
