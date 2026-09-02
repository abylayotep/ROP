import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Meta signs every delivery with the application secret.
 *
 * The hash must be taken over the exact bytes that arrived: parsing and re-serialising JSON
 * changes key order and whitespace, and the signature no longer matches.
 *
 * The comparison is constant-time. A byte-by-byte comparison that returns early leaks, through
 * timing, how much of a guessed signature was right, which is enough to forge one.
 */
export function verifySignature(
  raw: Buffer,
  header: string | undefined,
  secret: string,
): boolean {
  if (!header?.startsWith('sha256=')) return false;

  const expected = Buffer.from(
    `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`,
    'utf8',
  );
  const given = Buffer.from(header, 'utf8');

  // timingSafeEqual throws on a length mismatch, so the lengths are compared first — a
  // wrong length is not a secret worth protecting.
  return expected.length === given.length && timingSafeEqual(expected, given);
}
