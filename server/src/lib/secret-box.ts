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

/** A fresh nonce per call, so encrypting the same token twice does not produce equal rows. */
export function encryptSecret(plain: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);

  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), body.toString('base64')].join('.');
}

export function decryptSecret(packed: string, key: Buffer): string {
  const parts = packed.split('.');
  if (parts.length !== 3) throw new Error('Stored secret is malformed');

  const [iv, tag, body] = parts as [string, string, string];
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));

  // Throws on a wrong key or edited ciphertext — GCM verifies the tag in final().
  return Buffer.concat([
    decipher.update(Buffer.from(body, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/** The key as bytes. Validated at boot, so this cannot be the wrong length here. */
export const credentialsKey = (env: Env): Buffer => Buffer.from(env.CREDENTIALS_KEY, 'base64');
