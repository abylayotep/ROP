import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  makeCacheableSignalKeyStore,
  proto,
  type WASocket,
} from '@whiskeysockets/baileys';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../../../db/client.js';
import { messages } from '../../../db/schema.js';
import { linkedAuthState } from './auth-state.js';
import type {
  LinkedEvent,
  LinkedSession,
  LinkedSessionFactory,
  OutgoingFile,
  RawLinkedHistory,
  RawLinkedMessage,
} from './client.js';

/**
 * The only file in the product that imports Baileys.
 *
 * Everything it knows about WhatsApp stops here: the registry above it is handed our own
 * `LinkedSession`, and the pipelines below it are handed our own events. That boundary is
 * what lets a test describe an incoming photo as an object literal, and what makes the
 * library's next breaking change a change to one file.
 */

/**
 * Baileys logs every frame it sends and receives at debug level through a pino instance it
 * creates for itself. In production that is a stream of customers' message text into the
 * server log. This is the interface it needs: silent, except that a warning or an error —
 * a message that failed to decrypt, a retry it could not serve — is written as its one-line
 * description only. The structured object that comes with it can hold message content and
 * is dropped; without these lines a customer's «Waiting for this message» is invisible.
 */
interface SilentLogger {
  level: string;
  child(): SilentLogger;
  trace(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  fatal(...args: unknown[]): void;
}

const describeLog = (args: unknown[]): string => {
  const [first, second] = args;
  const text = typeof first === 'string' ? first : typeof second === 'string' ? second : '';
  const err = (first as { err?: { message?: unknown } } | undefined)?.err?.message;
  return [text, typeof err === 'string' ? err : ''].filter(Boolean).join(': ');
};

const quiet = (): SilentLogger => {
  const nothing = (): void => undefined;
  const report = (level: 'warn' | 'error') => (...args: unknown[]): void => {
    const line = describeLog(args);
    if (line) console[level](`[baileys] ${line}`);
  };
  const logger: SilentLogger = {
    level: 'warn',
    child: () => logger,
    trace: nothing,
    debug: nothing,
    info: nothing,
    warn: report('warn'),
    error: report('error'),
    fatal: report('error'),
  };
  return logger;
};

/**
 * Recently sent messages, by id.
 *
 * When a customer's phone cannot decrypt a message it asks for it again, and Baileys must be
 * handed the original to re-encrypt. Anything we cannot produce stays «Waiting for this
 * message» on their phone for good.
 */
const SENT_MEMORY = 500;

/** The retry-counter store Baileys expects: a Map with the cache interface's names. */
const retryCounters = () => {
  const map = new Map<string, number>();
  return {
    get: <T>(key: string) => map.get(key) as T | undefined,
    set: <T>(key: string, value: T) => {
      if (map.size >= 2000) map.delete(map.keys().next().value as string);
      map.set(key, value as unknown as number);
    },
    del: (key: string) => { map.delete(key); },
    flushAll: () => map.clear(),
  };
};

// Native DARWIN/WIN32 subplatforms are rejected with 428 before authentication.
// Keep the supported web subplatform even when requesting available full history.
const BROWSER = Browsers.ubuntu('Chrome');

/** `77085807932:12@s.whatsapp.net` → `+77085807932`. */
function displayPhoneOf(jid: string): string {
  const digits = jid.split('@')[0]?.split(':')[0] ?? '';
  return digits ? `+${digits}` : '';
}

/** Which Baileys content key a file goes under, by its mime type. */
function mediaContent(file: OutgoingFile): Record<string, unknown> {
  const source = { url: file.path };
  if (file.mime.startsWith('image/')) return { image: source, caption: file.caption };
  if (file.mime.startsWith('video/')) return { video: source, caption: file.caption };
  if (file.mime.startsWith('audio/')) return { audio: source, mimetype: file.mime };
  return {
    document: source,
    mimetype: file.mime,
    fileName: file.filename ?? 'file',
    caption: file.caption,
  };
}

/**
 * Builds the factory the registry calls.
 *
 * Curried over the database and the credentials key because the registry knows about
 * neither: it asks for «a session for this number» and the session knows where its own
 * credentials live.
 */
export function createLinkedSocket(db: Db, key: Buffer, archive?: {
  capture(numberId: string, notification: string): Promise<void>;
  onError(): void;
}): LinkedSessionFactory {
  return async (numberId: string, emit: (event: LinkedEvent) => void): Promise<LinkedSession> => {
    const auth = await linkedAuthState(db, key, numberId);
    const logger = quiet();
    const sent = new Map<string, proto.IMessage>();
    const remember = (result: { key?: { id?: string | null }; message?: proto.IMessage | null } | undefined): void => {
      const id = result?.key?.id;
      if (!id || !result?.message) return;
      if (sent.size >= SENT_MEMORY) sent.delete(sent.keys().next().value as string);
      sent.set(id, result.message);
    };
    let identityVerified = !auth.expectedPhone;
    let identityRejected = false;

    const sock: WASocket = makeWASocket({
      auth: { creds: auth.state.creds, keys: makeCacheableSignalKeyStore(auth.state.keys as never, logger as never) } as never,
      msgRetryCounterCache: retryCounters() as never,
      // Re-encrypts a message the customer's phone could not read. Text survives a restart
      // because the row holds it; media only lives in memory, and is gone after one.
      getMessage: async (key: { id?: string | null }) => {
        if (!key.id) return undefined;
        const kept = sent.get(key.id);
        if (kept) return kept;
        try {
          const [row] = await db.select({ body: messages.body, kind: messages.kind })
            .from(messages)
            .where(and(eq(messages.waMessageId, key.id), eq(messages.direction, 'out')));
          return row?.kind === 'text' && row.body ? { conversation: row.body } : undefined;
        } catch {
          return undefined;
        }
      },
      logger: logger as never,
      browser: BROWSER,
      // The QR belongs on the owner's screen, not in the server's stdout.
      printQRInTerminal: false,
      // We mirror what the phone sends; asking WhatsApp to mark chats read from here would
      // clear the owner's own unread badges on their handset.
      markOnlineOnConnect: false,
      // Only the recent slice the official web client asks for. Asking for everything the
      // phone holds is not what a browser does, and a linked device that looks unlike a
      // browser is part of what got a customer's number blocked on 2026-09-14. Older chats
      // come through the paced on-demand request instead.
      syncFullHistory: false,
      ...(archive ? { shouldSyncHistoryMessage: (notification: proto.Message.IHistorySyncNotification) => {
        if (identityVerified && !identityRejected && notification.directPath && notification.mediaKey) {
          const encoded = Buffer.from(proto.Message.HistorySyncNotification.encode(notification).finish()).toString('base64');
          void archive.capture(numberId, encoded).catch(() => archive.onError());
        }
        // Baileys also uses this predicate to advance its initial app-state sync.
        // Preserve that state machine, but import only from our durable raw copy below.
        return true;
      } } : {}),
    } as never);

    sock.ev.on('creds.update', () => void auth.saveCreds());

    sock.ev.on('connection.update', (update) => {
      if (update.qr) emit({ type: 'qr', numberId, qr: update.qr });

      if (update.connection === 'open') {
        const jid = sock.user?.id ?? '';
        if (auth.expectedPhone && displayPhoneOf(jid) !== `+${auth.expectedPhone}`) {
          identityRejected = true;
          void sock.logout().catch(() => sock.end(new Error('Phone identity mismatch')));
          return;
        }
        identityVerified = true;
        emit({ type: 'open', numberId, jid, displayPhone: displayPhoneOf(jid) });
      }

      if (update.connection === 'close') {
        // Baileys wraps the reason in a Boom error; only `loggedOut` is terminal, and
        // everything else — a restart, a timeout, a flat battery — is worth reconnecting.
        const status = (update.lastDisconnect?.error as { output?: { statusCode?: number } })
          ?.output?.statusCode;
        emit({ type: 'closed', numberId, loggedOut: identityRejected || status === DisconnectReason.loggedOut,
          ...(typeof status === 'number' && Number.isFinite(status) ? { statusCode: status } : {}),
        });
      }
    });

    sock.ev.on('messages.upsert', (upsert) => {
      if (!identityVerified || identityRejected) return;
      // Appended/offline messages still belong in storage. Route them through the history
      // pipeline, which deduplicates and never sends AI replies or opens a reply window.
      if (upsert.type === 'append') {
        emit({ type: 'history', numberId, chunk: {
          messages: upsert.messages as unknown as RawLinkedMessage[], contacts: [],
        } });
        return;
      }
      if (upsert.type !== 'notify') return;
      for (const message of upsert.messages) {
        emit({ type: 'message', numberId, message: message as unknown as RawLinkedMessage });
      }
    });

    sock.ev.on('messaging-history.set', (chunk) => {
      if (!identityVerified || identityRejected) return;
      if (archive) return;
      const history: RawLinkedHistory = {
        messages: (chunk.messages ?? []) as unknown as RawLinkedMessage[],
        contacts: (chunk.contacts ?? []) as RawLinkedHistory['contacts'],
        chats: (chunk.chats ?? []).map(chat => ({ id: chat.id, pnJid: chat.pnJid, lidJid: chat.lidJid })),
        progress: chunk.progress ?? null,
        peerDataRequestSessionId: chunk.peerDataRequestSessionId ?? null,
      };
      emit({ type: 'history', numberId, chunk: history });
    });

    const idOf = (result: { key?: { id?: string | null } } | undefined): string => {
      const id = result?.key?.id;
      // Baileys returns the message it queued; no id means it queued nothing, and reporting
      // success for that would store a row for a message that never left.
      if (!id) throw new Error('WhatsApp accepted no message id');
      return id;
    };

    return {
      async sendText(toJid, body) {
        const result = await sock.sendMessage(toJid, { text: body });
        remember(result);
        return { messageId: idOf(result) };
      },

      async sendMedia(toJid, file) {
        const result = await sock.sendMessage(toJid, mediaContent(file) as never);
        remember(result);
        return { messageId: idOf(result) };
      },

      async downloadMedia(message) {
        return (await downloadMediaMessage(
          message as never,
          'buffer',
          {},
          // `reuploadRequest` is how Baileys asks the phone for a file whose copy on
          // WhatsApp's servers has expired — which is most of what history holds.
          { logger: logger as never, reuploadRequest: sock.updateMediaMessage },
        )) as Buffer;
      },

      requestHistory(count, oldestMsgKey, oldestMsgTimestamp) {
        return sock.fetchMessageHistory(count, oldestMsgKey as never, oldestMsgTimestamp);
      },

      async close() {
        // `end` rather than `logout`: the session stays valid and the next connect resumes
        // it without troubling the owner for another QR code.
        sock.end(undefined);
      },

      async logout() {
        try {
          await sock.logout();
        } finally {
          // Whether or not WhatsApp acknowledged, this device is not coming back: keeping
          // the session would leave a row that fails to authenticate on every reconnect.
          await auth.clear();
        }
      },
    };
  };
}
