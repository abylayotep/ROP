# Task 4: Password hashing

Part of [Foundation Implementation Plan](2026-08-06-foundation.md). Global constraints there apply.

**Files:**
- Create: `server/src/lib/password.ts`, `server/test/password.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `hashPassword(plain: string): Promise<string>`,
  `verifyPassword(hash: string, plain: string): Promise<boolean>`

- [ ] **Step 1: Write the failing test**

`server/test/password.test.ts`. The malformed-hash case is the one that matters most: `argon2`
throws rather than returning `false` when handed something that is not a valid hash, and an
unhandled throw inside a login route turns a wrong-password attempt into a 500.

```ts
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
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm --prefix server test password`
Expected: FAIL — cannot resolve `../src/lib/password.js`.

- [ ] **Step 3: Implement**

`server/src/lib/password.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests**

Run: `npm --prefix server test password`
Expected: PASS, 6 tests.

- [ ] **Step 5: Typecheck**

Run: `npm --prefix server run typecheck`
Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add server/src/lib/password.ts server/test/password.test.ts
git commit -m "Add argon2id password hashing

verifyPassword swallows argon2's rejection on malformed input so a bad
login is a 401 rather than a 500."
```
