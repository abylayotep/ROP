import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret } from '../src/lib/secret-box.js';

const key = randomBytes(32);
const aad = 'phone-number-id-1';

describe('secret box', () => {
  it('returns the original text', () => {
    const packed = encryptSecret('EAAG...a-real-looking-token', key, aad);

    expect(decryptSecret(packed, key, aad)).toBe('EAAG...a-real-looking-token');
  });

  it('never stores the plain text', () => {
    expect(encryptSecret('super-secret', key, aad)).not.toContain('super-secret');
  });

  it('gives a different result every time, so equal tokens do not look equal', () => {
    expect(encryptSecret('same', key, aad)).not.toBe(encryptSecret('same', key, aad));
  });

  it('refuses text that was tampered with', () => {
    const [iv, tag, body] = encryptSecret('original', key, aad).split('.');
    const flipped = Buffer.from(body!, 'base64');
    flipped[0] = flipped[0]! ^ 0xff;

    expect(() =>
      decryptSecret([iv, tag, flipped.toString('base64')].join('.'), key, aad),
    ).toThrow();
  });

  it('refuses another key', () => {
    expect(() => decryptSecret(encryptSecret('original', key, aad), randomBytes(32), aad)).toThrow();
  });

  it('refuses a value that is not in the stored shape', () => {
    expect(() => decryptSecret('not-encrypted-at-all', key, aad)).toThrow(
      'Stored secret is malformed',
    );
  });

  it('refuses to decrypt with associated data from a different row', () => {
    const packed = encryptSecret('original', key, 'phone-number-id-1');

    expect(() => decryptSecret(packed, key, 'phone-number-id-2')).toThrow();
  });

  it('round-trips when the same associated data is passed both times', () => {
    const packed = encryptSecret('original', key, 'phone-number-id-1');

    expect(decryptSecret(packed, key, 'phone-number-id-1')).toBe('original');
  });
});
