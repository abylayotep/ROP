import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Env } from '../env.js';

/**
 * Symmetric encryption for the credentials we store on a client's behalf.
 *
 * A WhatsApp access token can send messages as the client's business, so a database dump
 * or one careless `psql` session would otherwise hand that ability to whoever read it.
 *
 * AES-256-GCM rather than CBC: it authenticates as well as encrypts, so a value edited in
 * the database fails to decrypt instead of decrypting into something else.
 */

const ALGORITHM = 'aes-256-gcm';

/** 96 bits is the size GCM is specified for; longer nonces are hashed and gain nothing. */
const IV_BYTES = 12;

/**
 * `aad` (associated data) must be the value that identifies the row this secret belongs
 * to — stable for the row's whole life. In this product that is the WhatsApp
 * `phone_number_id`: it is the number's identity, is known before the insert, and is
 * never edited (the PATCH on that table changes `enabled` and the token, never this).
 * A replaced token is therefore re-encrypted under the same aad. Binding the ciphertext
 * to it means a value copied from one row into another fails to decrypt, so UPDATE
 * access to the database is not enough to move client A's token onto client B's row.
 */

/** A fresh nonce per call, so encrypting the same token twice does not produce equal rows. */
export function encryptSecret(plain: string, key: Buffer, aad: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);

  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), body.toString('base64')].join('.');
}

export function decryptSecret(packed: string, key: Buffer, aad: string): string {
  const parts = packed.split('.');
  if (parts.length !== 3) throw new Error('Stored secret is malformed');

  const [iv, tag, body] = parts as [string, string, string];
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  decipher.setAAD(Buffer.from(aad, 'utf8'));

  // Throws on a wrong key, a wrong aad, or edited ciphertext — GCM verifies the tag in final().
  return Buffer.concat([
    decipher.update(Buffer.from(body, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/** The key as bytes. Validated at boot, so this cannot be the wrong length here. */
export const credentialsKey = (env: Env): Buffer => Buffer.from(env.CREDENTIALS_KEY, 'base64');
