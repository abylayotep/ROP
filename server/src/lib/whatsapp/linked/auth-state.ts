import { BufferJSON, initAuthCreds, type AuthenticationCreds } from '@whiskeysockets/baileys';
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../../../db/client.js';
import { linkedSessionKeys } from '../../../db/schema.js';
import { decryptSecret, encryptSecret } from '../../secret-box.js';

/**
 * A linked device's Baileys session, kept in Postgres instead of in files.
 *
 * Baileys ships `useMultiFileAuthState` — one JSON file per key under a directory — as the
 * reference implementation of this contract. Files would mean a volume to mount, back up and
 * lose; this product already has a database and a key for encrypting credentials, and a
 * session is a credential: whoever holds it can send as the owner.
 *
 * The shape below is exactly what `makeWASocket({ auth })` expects. Everything interesting
 * about the implementation is in three places: `BufferJSON`, the aad, and what a row that
 * fails to decrypt is taken to mean.
 */

/** `creds` is a category with exactly one member. This is its id. */
const CREDS_ID = 'me';
const CREDS_CATEGORY = 'creds';

/**
 * Signal keys are `Buffer`s, and `JSON.stringify` turns a Buffer into
 * `{"type":"Buffer","data":[…]}`. Baileys' replacer and reviver are what make the round trip
 * lossless; without them the session survives storage, fails at the first message, and does
 * so inside libsignal with an error that says nothing about serialization.
 */
const encode = (value: unknown): string => JSON.stringify(value, BufferJSON.replacer);
const decode = (raw: string): unknown => JSON.parse(raw, BufferJSON.reviver);

/**
 * What binds a stored value to the row it belongs to.
 *
 * The same rule the access tokens follow: a value copied from one number's row to another's
 * fails to decrypt, so UPDATE access to the database is not enough to move one owner's
 * session onto another owner's number.
 */
const aad = (numberId: string, category: string, keyId: string): string =>
  `${numberId}:${category}:${keyId}`;

export interface LinkedAuthState {
  state: {
    creds: AuthenticationCreds;
    keys: {
      get(type: string, ids: string[]): Promise<Record<string, unknown>>;
      set(data: Record<string, Record<string, unknown> | undefined>): Promise<void>;
    };
  };
  /** Called by the socket on every `creds.update`. */
  saveCreds(): Promise<void>;
  /** Forgets the session entirely. Only a logout Meta confirmed should reach this. */
  clear(): Promise<void>;
}

export async function linkedAuthState(
  db: Db,
  key: Buffer,
  numberId: string,
): Promise<LinkedAuthState> {
  const readOne = async (category: string, keyId: string): Promise<unknown> => {
    const [row] = await db
      .select()
      .from(linkedSessionKeys)
      .where(
        and(
          eq(linkedSessionKeys.whatsappNumberId, numberId),
          eq(linkedSessionKeys.category, category),
          eq(linkedSessionKeys.keyId, keyId),
        ),
      );
    if (!row) return undefined;
    return readValue(row.value, category, keyId);
  };

  /**
   * A row we cannot read is an absent key, not a crash.
   *
   * The two ways this happens are a rotated credentials key and a row someone edited. Both
   * mean the session is gone. Throwing would take the socket down on every reconnect
   * attempt; answering «no such key» lets Baileys conclude what is actually true — this
   * device is not paired any more — and ask for a new QR code.
   */
  const readValue = (packed: string, category: string, keyId: string): unknown => {
    try {
      return decode(decryptSecret(packed, key, aad(numberId, category, keyId)));
    } catch {
      return undefined;
    }
  };

  const write = async (category: string, keyId: string, value: unknown): Promise<void> => {
    const packed = encryptSecret(encode(value), key, aad(numberId, category, keyId));
    await db
      .insert(linkedSessionKeys)
      .values({ whatsappNumberId: numberId, category, keyId, value: packed })
      .onConflictDoUpdate({
        target: [
          linkedSessionKeys.whatsappNumberId,
          linkedSessionKeys.category,
          linkedSessionKeys.keyId,
        ],
        set: { value: packed, updatedAt: new Date() },
      });
  };

  const stored = (await readOne(CREDS_CATEGORY, CREDS_ID)) as AuthenticationCreds | undefined;
  const creds = stored ?? initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        /**
         * One query for every id asked for. Baileys asks for dozens of pre-keys at a time,
         * and a query per id turns one handshake into dozens of round trips.
         */
        async get(type, ids) {
          if (ids.length === 0) return {};
          const rows = await db
            .select()
            .from(linkedSessionKeys)
            .where(
              and(
                eq(linkedSessionKeys.whatsappNumberId, numberId),
                eq(linkedSessionKeys.category, type),
                inArray(linkedSessionKeys.keyId, ids),
              ),
            );

          const found: Record<string, unknown> = {};
          for (const row of rows) {
            const value = readValue(row.value, type, row.keyId);
            if (value !== undefined) found[row.keyId] = value;
          }
          return found;
        },

        /**
         * Baileys hands over a whole tree at once, and a `null` value inside it means
         * «forget this key». Deletes are collected and issued as one statement per
         * category rather than one per key.
         */
        async set(data) {
          for (const [type, entries] of Object.entries(data)) {
            if (!entries) continue;
            const doomed: string[] = [];
            for (const [keyId, value] of Object.entries(entries)) {
              if (value === null || value === undefined) doomed.push(keyId);
              else await write(type, keyId, value);
            }
            if (doomed.length > 0) {
              await db
                .delete(linkedSessionKeys)
                .where(
                  and(
                    eq(linkedSessionKeys.whatsappNumberId, numberId),
                    eq(linkedSessionKeys.category, type),
                    inArray(linkedSessionKeys.keyId, doomed),
                  ),
                );
            }
          }
        },
      },
    },

    async saveCreds() {
      await write(CREDS_CATEGORY, CREDS_ID, creds);
    },

    async clear() {
      await db
        .delete(linkedSessionKeys)
        .where(eq(linkedSessionKeys.whatsappNumberId, numberId));
    },
  };
}
