import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  type WASocket,
} from '@whiskeysockets/baileys';
import type { Db } from '../../../db/client.js';
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
 * server log. This is the interface it needs, doing nothing.
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

const silent = (): SilentLogger => {
  const nothing = (): void => undefined;
  const logger: SilentLogger = {
    level: 'silent',
    child: () => logger,
    trace: nothing,
    debug: nothing,
    info: nothing,
    warn: nothing,
    error: nothing,
    fatal: nothing,
  };
  return logger;
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
export function createLinkedSocket(db: Db, key: Buffer): LinkedSessionFactory {
  return async (numberId: string, emit: (event: LinkedEvent) => void): Promise<LinkedSession> => {
    const auth = await linkedAuthState(db, key, numberId);
    const logger = silent();

    const sock: WASocket = makeWASocket({
      auth: auth.state as never,
      logger: logger as never,
      browser: BROWSER,
      // The QR belongs on the owner's screen, not in the server's stdout.
      printQRInTerminal: false,
      // We mirror what the phone sends; asking WhatsApp to mark chats read from here would
      // clear the owner's own unread badges on their handset.
      markOnlineOnConnect: false,
      // The library's default asks the phone for a recent slice only, which is a handful of
      // chats — not enough to read a shop's own selling back to it. The cabinet's whole
      // reason for taking the history is the script it builds out of it, and that wants
      // months, so the phone is asked for everything it still holds. The import stores rows
      // and downloads no files, so the cost is a longer first sync, not a disk full of
      // photos.
      syncFullHistory: true,
    } as never);

    sock.ev.on('creds.update', () => void auth.saveCreds());

    sock.ev.on('connection.update', (update) => {
      if (update.qr) emit({ type: 'qr', numberId, qr: update.qr });

      if (update.connection === 'open') {
        const jid = sock.user?.id ?? '';
        emit({ type: 'open', numberId, jid, displayPhone: displayPhoneOf(jid) });
      }

      if (update.connection === 'close') {
        // Baileys wraps the reason in a Boom error; only `loggedOut` is terminal, and
        // everything else — a restart, a timeout, a flat battery — is worth reconnecting.
        const status = (update.lastDisconnect?.error as { output?: { statusCode?: number } })
          ?.output?.statusCode;
        emit({ type: 'closed', numberId, loggedOut: status === DisconnectReason.loggedOut,
          ...(typeof status === 'number' && Number.isFinite(status) ? { statusCode: status } : {}),
        });
      }
    });

    sock.ev.on('messages.upsert', (upsert) => {
      // `append` is the library filling in history it already had; replaying it as new
      // would answer lines that were answered months ago.
      if (upsert.type !== 'notify') return;
      for (const message of upsert.messages) {
        emit({ type: 'message', numberId, message: message as unknown as RawLinkedMessage });
      }
    });

    sock.ev.on('messaging-history.set', (chunk) => {
      const history: RawLinkedHistory = {
        messages: (chunk.messages ?? []) as unknown as RawLinkedMessage[],
        contacts: (chunk.contacts ?? []) as RawLinkedHistory['contacts'],
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
        return { messageId: idOf(await sock.sendMessage(toJid, { text: body })) };
      },

      async sendMedia(toJid, file) {
        return { messageId: idOf(await sock.sendMessage(toJid, mediaContent(file) as never)) };
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
