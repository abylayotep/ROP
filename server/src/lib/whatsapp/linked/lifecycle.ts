import { and, eq } from 'drizzle-orm';
import type { Db } from '../../../db/client.js';
import { whatsappNumbers } from '../../../db/schema.js';
import { linkedAuthState } from './auth-state.js';
import type { LinkedRegistry } from './client.js';

/**
 * Keeping the phones connected, and writing down when they are not.
 *
 * The registry owns sockets and knows nothing about the database; this is the other half —
 * it watches the same event stream and decides what a disconnect means for the row.
 */

/** 1s, 2s, 4s … capped. A phone in a lift is back in seconds; one left at home is not. */
const FIRST_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60_000;

/**
 * After this many failures in a row the number is left alone until someone acts.
 *
 * Not marked `logged_out`: WhatsApp has not said the pairing is gone, and telling an owner
 * to scan a new QR code because their phone was off for an hour would be a lie that costs
 * them the session they still have.
 */
const MAX_ATTEMPTS = 12;

export interface LifecycleOptions {
  /** Injected by tests. Production waits with `setTimeout`. */
  schedule?: (run: () => void, ms: number) => void;
  onError?: (message: string) => void;
}

export function registerLinkedLifecycle(
  db: Db,
  key: Buffer,
  client: LinkedRegistry,
  options: LifecycleOptions = {},
): void {
  const schedule = options.schedule ?? ((run, ms) => void setTimeout(run, ms).unref?.());
  const attempts = new Map<string, number>();

  client.on((event) => {
    if (event.type === 'open') {
      attempts.delete(event.numberId);
      void db
        .update(whatsappNumbers)
        .set({
          linkedState: 'open',
          linkedJid: event.jid,
          // Only once, at pairing: an owner who renamed the number in the cabinet should
          // keep their name. The pairing route writes a placeholder, and this is what
          // replaces it.
          ...(event.displayPhone ? { displayPhone: event.displayPhone } : {}),
        })
        .where(eq(whatsappNumbers.id, event.numberId))
        .catch((error: unknown) => report(error));
      return;
    }

    if (event.type !== 'closed') return;

    if (event.loggedOut) {
      // WhatsApp discarded the pairing. Nothing here can bring it back, and keeping the
      // session would fail to authenticate on every attempt for as long as the row lives.
      void forget(event.numberId).catch((error: unknown) => report(error));
      return;
    }

    const attempt = (attempts.get(event.numberId) ?? 0) + 1;
    attempts.set(event.numberId, attempt);
    if (attempt > MAX_ATTEMPTS) {
      options.onError?.(
        `телефон номера ${event.numberId} не отвечает после ${MAX_ATTEMPTS} попыток`,
      );
      return;
    }

    const wait = Math.min(FIRST_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
    schedule(() => {
      void client.connect(event.numberId).catch((error: unknown) => report(error));
    }, wait);
  });

  async function forget(numberId: string): Promise<void> {
    await db
      .update(whatsappNumbers)
      .set({ linkedState: 'logged_out' })
      .where(eq(whatsappNumbers.id, numberId));
    await (await linkedAuthState(db, key, numberId)).clear();
    attempts.delete(numberId);
  }

  function report(error: unknown): void {
    options.onError?.(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Reconnects every phone that was connected when the process last stopped.
 *
 * Sequential and forgiving: a server that refused to start because one owner's phone is
 * unreachable would take every other client down with it. Call it after `listen` — the
 * cabinet must answer HTTP before it waits on handsets.
 */
export async function restoreLinkedSessions(
  db: Db,
  client: LinkedRegistry,
  onError?: (message: string) => void,
): Promise<void> {
  const rows = await db
    .select({ id: whatsappNumbers.id })
    .from(whatsappNumbers)
    .where(
      and(
        eq(whatsappNumbers.connectionKind, 'linked'),
        eq(whatsappNumbers.linkedState, 'open'),
        eq(whatsappNumbers.enabled, true),
      ),
    );

  for (const row of rows) {
    try {
      await client.connect(row.id);
    } catch (error) {
      onError?.(
        `не удалось подключить телефон ${row.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
