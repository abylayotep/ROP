import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret } from '../src/lib/secret-box.js';

const key = randomBytes(32);

describe('secret box', () => {
  it('returns the original text', () => {
    const packed = encryptSecret('EAAG...a-real-looking-token', key);

    expect(decryptSecret(packed, key)).toBe('EAAG...a-real-looking-token');
  });

  it('never stores the plain text', () => {
    expect(encryptSecret('super-secret', key)).not.toContain('super-secret');
  });

  it('gives a different result every time, so equal tokens do not look equal', () => {
    expect(encryptSecret('same', key)).not.toBe(encryptSecret('same', key));
  });

  it('refuses text that was tampered with', () => {
    const [iv, tag, body] = encryptSecret('original', key).split('.');
    const flipped = Buffer.from(body!, 'base64');
    flipped[0] = flipped[0]! ^ 0xff;

    expect(() => decryptSecret([iv, tag, flipped.toString('base64')].join('.'), key)).toThrow();
  });

  it('refuses another key', () => {
    expect(() => decryptSecret(encryptSecret('original', key), randomBytes(32))).toThrow();
  });

  it('refuses a value that is not in the stored shape', () => {
    expect(() => decryptSecret('not-encrypted-at-all', key)).toThrow(
      'Stored secret is malformed',
    );
  });
});
