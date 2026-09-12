import { describe, expect, it, vi } from 'vitest';
import {
  createLinkedClient,
  LinkedOffline,
  type LinkedEvent,
  type LinkedSession,
  type LinkedSessionFactory,
} from '../src/lib/whatsapp/linked/client.js';

/**
 * The registry, not WhatsApp.
 *
 * Everything here is about what `createLinkedClient` owes its callers: one session per
 * number, events fanned out to everyone listening, and a refusal — never a silent no-op —
 * when a number is asked to send while its phone is away.
 */

function session(overrides: Partial<LinkedSession> = {}): LinkedSession {
  return {
    sendText: async () => ({ messageId: 'wa.1' }),
    sendMedia: async () => ({ messageId: 'wa.2' }),
    downloadMedia: async () => Buffer.from([1]),
    requestHistory: async () => 'history-session',
    close: async () => undefined,
    logout: async () => undefined,
    ...overrides,
  };
}

/** A factory that opens immediately, the way a restored session does. */
function opening(build: () => LinkedSession = session): LinkedSessionFactory {
  return async (numberId, emit) => {
    const built = build();
    emit({ type: 'open', numberId, jid: `${numberId}@s.whatsapp.net`, displayPhone: '+7 700' });
    return built;
  };
}

describe('linked client registry', () => {
  it('is open once its session says so', async () => {
    const client = createLinkedClient({ session: opening() });

    await client.connect('n1');

    expect(client.isOpen('n1')).toBe(true);
  });

  it('builds one session per number, however often connect is called', async () => {
    const factory = vi.fn(opening());
    const client = createLinkedClient({ session: factory });

    await client.connect('n1');
    await client.connect('n1');

    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('refuses to send through a number that is not open', async () => {
    const client = createLinkedClient({ session: opening() });

    await expect(client.sendText('n1', '7700@s.whatsapp.net', 'привет')).rejects.toBeInstanceOf(
      LinkedOffline,
    );
  });

  it('refuses to send through a number whose socket has closed', async () => {
    const client = createLinkedClient({ session: opening() });
    await client.connect('n1');

    // The socket dropped; the session object is still in the registry, waiting to reconnect.
    client.report({ type: 'closed', numberId: 'n1', loggedOut: false });

    await expect(client.sendText('n1', '7700@s.whatsapp.net', 'привет')).rejects.toBeInstanceOf(
      LinkedOffline,
    );
  });

  it('builds a new session when connect follows a close', async () => {
    const factory = vi.fn(opening());
    const client = createLinkedClient({ session: factory });
    await client.connect('n1');

    // What the lifecycle does after a drop. The dead socket must not be reused: reconnecting
    // through it is a no-op, and the number never comes back.
    client.report({ type: 'closed', numberId: 'n1', loggedOut: false });
    await client.connect('n1');

    expect(factory).toHaveBeenCalledTimes(2);
    expect(client.isOpen('n1')).toBe(true);
  });

  it('sends through the session of the number it was asked about', async () => {
    const sent: string[] = [];
    const client = createLinkedClient({
      session: opening(() => session({ sendText: async (to, body) => {
        sent.push(`${to}:${body}`);
        return { messageId: 'wa.9' };
      } })),
    });
    await client.connect('n1');

    const result = await client.sendText('n1', '7700@s.whatsapp.net', 'привет');

    expect(sent).toEqual(['7700@s.whatsapp.net:привет']);
    expect(result.messageId).toBe('wa.9');
  });

  it('delivers every event to every handler', async () => {
    const client = createLinkedClient({ session: opening() });
    const first: LinkedEvent[] = [];
    const second: LinkedEvent[] = [];
    client.on((event) => first.push(event));
    client.on((event) => second.push(event));

    await client.connect('n1');

    expect(first.map((e) => e.type)).toEqual(['open']);
    expect(second.map((e) => e.type)).toEqual(['open']);
  });

  it('keeps delivering to the other handlers when one throws', async () => {
    // A handler is the inbound pipeline. One of them failing on a malformed message must
    // not cost the others theirs — nor kill the socket that emitted it.
    const client = createLinkedClient({ session: opening() });
    const seen: LinkedEvent[] = [];
    client.on(() => {
      throw new Error('handler blew up');
    });
    client.on((event) => seen.push(event));

    await client.connect('n1');

    expect(seen).toHaveLength(1);
  });

  it('closes the session on disconnect and forgets it', async () => {
    let closed = 0;
    const client = createLinkedClient({
      session: opening(() => session({ close: async () => { closed += 1; } })),
    });
    await client.connect('n1');

    await client.disconnect('n1');

    expect(closed).toBe(1);
    expect(client.isOpen('n1')).toBe(false);
  });

  it('logs out through the session and forgets it', async () => {
    let loggedOut = 0;
    const client = createLinkedClient({
      session: opening(() => session({ logout: async () => { loggedOut += 1; } })),
    });
    await client.connect('n1');

    await client.logout('n1');

    expect(loggedOut).toBe(1);
    expect(client.isOpen('n1')).toBe(false);
  });

  it('logging out a number that was never connected is not an error', async () => {
    const client = createLinkedClient({ session: opening() });

    await expect(client.logout('n1')).resolves.toBeUndefined();
  });

  it('does not leave a half-built session behind when the factory throws', async () => {
    const factory = vi.fn(async () => {
      throw new Error('no network');
    });
    const client = createLinkedClient({ session: factory as unknown as LinkedSessionFactory });

    await expect(client.connect('n1')).rejects.toThrow('no network');
    await expect(client.connect('n1')).rejects.toThrow('no network');
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('keeps two numbers apart', async () => {
    const client = createLinkedClient({ session: opening() });

    await client.connect('n1');

    expect(client.isOpen('n1')).toBe(true);
    expect(client.isOpen('n2')).toBe(false);
  });
});
