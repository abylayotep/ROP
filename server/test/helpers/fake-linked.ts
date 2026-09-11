import {
  LinkedOffline,
  type LinkedClient,
  type LinkedEvent,
  type OutgoingFile,
  type RawLinkedMessage,
} from '../../src/lib/whatsapp/linked/client.js';

export interface FakeLinked extends LinkedClient {
  /** Every call in order, so a test can assert what was asked of the phone. */
  calls: { method: keyof LinkedClient; args: unknown[] }[];
  /** Drives the registered handlers the way a real socket would. */
  emit(event: LinkedEvent): void;
  /** Flips what `isOpen` answers, without going through a connect. */
  setOpen(numberId: string, open: boolean): void;
  /** What the next `downloadMedia` hands back. */
  media: Buffer;
}

/**
 * A linked client that answers plausibly, records what it was asked, and lets the test
 * push events at it.
 *
 * The same arrangement as `fakeGraph`, plus the one thing a socket has and an HTTP client
 * does not: a test needs to say «and then a message arrived».
 */
export function fakeLinked(overrides: Partial<LinkedClient> = {}): FakeLinked {
  const calls: FakeLinked['calls'] = [];
  const handlers: ((event: LinkedEvent) => void)[] = [];
  const open = new Set<string>();
  let counter = 0;

  const record = <K extends keyof LinkedClient>(
    method: K,
    fallback: (...args: never[]) => unknown,
  ): LinkedClient[K] =>
    ((...args: unknown[]) => {
      calls.push({ method, args });
      const chosen = (overrides[method] ?? fallback) as (...a: unknown[]) => unknown;
      return chosen(...args);
    }) as LinkedClient[K];

  const requireOpen = (numberId: string): void => {
    if (!open.has(numberId)) throw new LinkedOffline(numberId);
  };

  const fake: FakeLinked = {
    calls,
    media: Buffer.from([1, 2, 3]),

    connect: record('connect', async (numberId: string) => {
      open.add(numberId);
    }),
    disconnect: record('disconnect', async (numberId: string) => {
      open.delete(numberId);
    }),
    logout: record('logout', async (numberId: string) => {
      open.delete(numberId);
    }),
    sendText: record('sendText', async (numberId: string) => {
      requireOpen(numberId);
      counter += 1;
      return { messageId: `linked.${counter}` };
    }),
    sendMedia: record('sendMedia', async (numberId: string, _to: string, _file: OutgoingFile) => {
      requireOpen(numberId);
      counter += 1;
      return { messageId: `linked.${counter}` };
    }),
    downloadMedia: record('downloadMedia', async (_id: string, _message: RawLinkedMessage) =>
      Promise.resolve(fake.media),
    ),
    isOpen: ((numberId: string) => open.has(numberId)) as LinkedClient['isOpen'],
    on(handler) {
      handlers.push(handler);
    },

    emit(event) {
      if (event.type === 'open') open.add(event.numberId);
      if (event.type === 'closed') open.delete(event.numberId);
      for (const handler of handlers) handler(event);
    },
    setOpen(numberId, isOpen) {
      if (isOpen) open.add(numberId);
      else open.delete(numberId);
    },
  };

  return fake;
}
