/**
 * The linked-device transport, as the rest of the product sees it.
 *
 * Everything here is our own shape. Baileys is imported by `socket.ts` and by nothing else,
 * not even for a type: a test that has to build `proto.IWebMessageInfo` to describe «a text
 * message arrived» is a test nobody writes twice. `socket.ts` casts the library's messages
 * into `RawLinkedMessage`, which is structurally what those messages are.
 */

import { createSendQueue, type SendQueue } from './queue.js';

/** A `Long` from protobuf, or the plain number Baileys sometimes hands over instead. */
export type Timestamp = number | { toNumber(): number } | null | undefined;

export interface RawLinkedContent {
  conversation?: string | null;
  extendedTextMessage?: { text?: string | null } | null;
  imageMessage?: { caption?: string | null; mimetype?: string | null } | null;
  videoMessage?: { caption?: string | null; mimetype?: string | null } | null;
  audioMessage?: { mimetype?: string | null } | null;
  documentMessage?: { caption?: string | null; mimetype?: string | null; fileName?: string | null } | null;
  stickerMessage?: { mimetype?: string | null } | null;
  /** A delivery receipt, a revoke, an ephemeral setting change — never a line in a chat. */
  protocolMessage?: unknown;
  reactionMessage?: unknown;
}

export interface RawLinkedMessage {
  key: {
    id?: string | null;
    remoteJid?: string | null;
    fromMe?: boolean | null;
    /** The sender phone JID accompanying a LID-addressed chat. */
    senderPn?: string | null;
  };
  messageTimestamp?: Timestamp;
  /** The sender's name as their phone reports it. */
  pushName?: string | null;
  message?: RawLinkedContent | null;
}

/** One chunk of `messaging-history.set`, reduced to what the import writes. */
export interface RawLinkedHistory {
  messages: RawLinkedMessage[];
  contacts: { id: string; name?: string | null; notify?: string | null }[];
  /** 0..100 while the phone is still sending, absent when the library does not say. */
  progress?: number | null;
  /** Correlates an on-demand request with the phone's eventual response. */
  peerDataRequestSessionId?: string | null;
}

export interface OutgoingFile {
  /** Absolute path on disk. The transport reads it; it never holds the bytes itself. */
  path: string;
  mime: string;
  filename?: string;
  caption?: string;
}

export type LinkedEvent =
  | { type: 'qr'; numberId: string; qr: string }
  | { type: 'open'; numberId: string; jid: string; displayPhone: string }
  | { type: 'closed'; numberId: string; loggedOut: boolean; statusCode?: number }
  | { type: 'message'; numberId: string; message: RawLinkedMessage }
  | { type: 'history'; numberId: string; chunk: RawLinkedHistory };

/**
 * The phone is not reachable right now.
 *
 * Distinct from a failed send: nothing was attempted. The routes turn this into a 409 with
 * a sentence naming which of the two reasons applies, because «откройте WhatsApp на
 * телефоне» and «подключите заново по QR» are different actions for the person reading it.
 */
export class LinkedOffline extends Error {
  constructor(readonly numberId: string) {
    super(`linked number ${numberId} is not connected`);
    this.name = 'LinkedOffline';
  }
}

export interface LinkedClient {
  /** Restores a stored session, or starts a new pairing when there is none. Idempotent. */
  connect(numberId: string): Promise<void>;
  /** Closes the socket and keeps the session, so the next connect resumes it. */
  disconnect(numberId: string): Promise<void>;
  /** Tells WhatsApp to forget this device. The session is gone afterwards. */
  logout(numberId: string): Promise<void>;
  sendText(numberId: string, toJid: string, body: string): Promise<{ messageId: string }>;
  sendMedia(numberId: string, toJid: string, file: OutgoingFile): Promise<{ messageId: string }>;
  downloadMedia(numberId: string, message: RawLinkedMessage): Promise<Buffer>;
  requestHistory?(
    numberId: string,
    count: number,
    oldestMsgKey: RawLinkedMessage['key'],
    oldestMsgTimestamp: number,
  ): Promise<string>;
  isOpen(numberId: string): boolean;
  /**
   * Subscribes to every event, and answers with the way to stop.
   *
   * The unsubscribe is not a nicety: the pairing stream subscribes per request, and a
   * handler left behind when the browser tab closes outlives the pairing and writes into
   * a response that has already ended.
   */
  on(handler: (event: LinkedEvent) => void): () => void;
}

/** One live socket, as the registry uses it. Implemented by `socket.ts`. */
export interface LinkedSession {
  sendText(toJid: string, body: string): Promise<{ messageId: string }>;
  sendMedia(toJid: string, file: OutgoingFile): Promise<{ messageId: string }>;
  downloadMedia(message: RawLinkedMessage): Promise<Buffer>;
  requestHistory?(count: number, oldestMsgKey: RawLinkedMessage['key'], oldestMsgTimestamp: number): Promise<string>;
  close(): Promise<void>;
  logout(): Promise<void>;
}

export type LinkedSessionFactory = (
  numberId: string,
  emit: (event: LinkedEvent) => void,
) => Promise<LinkedSession>;

export interface LinkedClientDeps {
  /** Builds one live socket. `socket.ts` in production, a stub in tests. */
  session: LinkedSessionFactory;
  /**
   * Paces the sends. Defaults to the real one; a test hands over a queue with no waiting,
   * because a suite that actually slept a second per message would take an hour.
   */
  queue?: SendQueue;
}

/** The registry, plus the one thing only it can do: inject an event from outside. */
export interface LinkedRegistry extends LinkedClient {
  /**
   * Publishes an event as if a socket had emitted it.
   *
   * The lifecycle code needs this to fold a reconnect into the same stream the sockets
   * feed, and a test needs it to say «the phone dropped» without a phone.
   */
  report(event: LinkedEvent): void;
}

/**
 * Owns the live sessions and the handler list, and knows nothing about WhatsApp.
 *
 * `isOpen` follows the events rather than the presence of a session object: a session is
 * in the map from the moment it is asked for, before the socket has opened, and sending
 * through it then would hand a message to a socket that cannot deliver it.
 */
export function createLinkedClient(deps: LinkedClientDeps): LinkedRegistry {
  const sessions = new Map<string, Promise<LinkedSession>>();
  const queue = deps.queue ?? createSendQueue();
  const open = new Set<string>();
  const handlers: ((event: LinkedEvent) => void)[] = [];

  const report = (event: LinkedEvent): void => {
    if (event.type === 'open') open.add(event.numberId);
    if (event.type === 'closed') {
      open.delete(event.numberId);
      // And the session with it. A closed socket never opens again — Baileys builds a new
      // one — so keeping it in the map would make the lifecycle's reconnect a no-op: it
      // calls `connect`, `connect` finds a session and returns, and the number stays dark
      // for as long as the process lives.
      sessions.delete(event.numberId);
    }
    for (const handler of handlers) {
      try {
        handler(event);
      } catch {
        // One handler's failure is not the others' and is certainly not the socket's.
        // The handler itself is responsible for saying what went wrong; swallowing here
        // only stops it spreading.
      }
    }
  };

  const live = async (numberId: string): Promise<LinkedSession> => {
    if (!open.has(numberId)) throw new LinkedOffline(numberId);
    const session = sessions.get(numberId);
    if (!session) throw new LinkedOffline(numberId);
    return session;
  };

  const forget = async (numberId: string, how: 'close' | 'logout'): Promise<void> => {
    const pending = sessions.get(numberId);
    sessions.delete(numberId);
    open.delete(numberId);
    if (!pending) return;
    const session = await pending;
    await session[how]();
  };

  return {
    async connect(numberId) {
      // The promise, not the resolved session, goes into the map: two connects racing must
      // build one socket, and the second has to wait for the first rather than start another.
      if (sessions.has(numberId)) {
        await sessions.get(numberId);
        return;
      }
      const pending = deps.session(numberId, report);
      sessions.set(numberId, pending);
      try {
        await pending;
      } catch (error) {
        // A factory that threw left nothing to reuse. Keeping the rejected promise would
        // make every later connect fail with the first attempt's error, forever.
        sessions.delete(numberId);
        open.delete(numberId);
        throw error;
      }
    },

    disconnect: (numberId) => forget(numberId, 'close'),
    logout: (numberId) => forget(numberId, 'logout'),

    // Queued, not sent: the check that the phone is there happens inside the queue, at the
    // moment the message actually goes out. Checking before the wait would let a socket
    // drop during the queue and hand the message to a session that cannot deliver it.
    sendText(numberId, toJid, body) {
      return queue(numberId, async () => (await live(numberId)).sendText(toJid, body));
    },

    sendMedia(numberId, toJid, file) {
      return queue(numberId, async () => (await live(numberId)).sendMedia(toJid, file));
    },

    async downloadMedia(numberId, message) {
      return (await live(numberId)).downloadMedia(message);
    },

    async requestHistory(numberId, count, oldestMsgKey, oldestMsgTimestamp) {
      const request = (await live(numberId)).requestHistory;
      if (!request) throw new Error('Linked session does not support on-demand history');
      return request(count, oldestMsgKey, oldestMsgTimestamp);
    },

    isOpen: (numberId) => open.has(numberId),
    on(handler) {
      handlers.push(handler);
      return () => {
        const at = handlers.indexOf(handler);
        if (at >= 0) handlers.splice(at, 1);
      };
    },
    report,
  };
}
