import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/lib/password.js';

describe('password', () => {
  it('does not store the plaintext', async () => {
    const hash = await hashPassword('correct horse battery staple');

    expect(hash).not.toContain('correct horse battery staple');
    expect(hash.startsWith('$argon2id$')).toBe(true);
  });

  it('salts, so the same password hashes differently each time', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
  });

  it('accepts the right password', async () => {
    const hash = await hashPassword('right');

    expect(await verifyPassword(hash, 'right')).toBe(true);
  });

  it('rejects the wrong password', async () => {
    const hash = await hashPassword('right');

    expect(await verifyPassword(hash, 'wrong')).toBe(false);
  });

  it('returns false rather than throwing on a malformed hash', async () => {
    expect(await verifyPassword('not-a-hash', 'anything')).toBe(false);
  });

  it('returns false rather than throwing on an empty hash', async () => {
    expect(await verifyPassword('', 'anything')).toBe(false);
  });
});
