import argon2 from 'argon2';

/** argon2id — the variant recommended against both GPU and side-channel attacks. */
export const hashPassword = (plain: string): Promise<string> =>
  argon2.hash(plain, { type: argon2.argon2id });

/**
 * Verification never throws. argon2.verify rejects on a malformed hash, and a rejection
 * here would turn a failed login into a 500 instead of a 401.
 */
export const verifyPassword = (hash: string, plain: string): Promise<boolean> =>
  argon2.verify(hash, plain).catch(() => false);
