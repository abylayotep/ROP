# Task 3: Auth state over Postgres

**Files:**
- Create: `server/src/lib/whatsapp/linked/auth-state.ts`, `server/test/linked-auth-state.test.ts`

**Interfaces:**
- Consumes: `linkedSessionKeys` (Task 2); `encryptSecret`, `decryptSecret`, `credentialsKey` from `server/src/lib/secret-box.ts`.
- Produces:

```ts
export interface LinkedAuthState {
  state: { creds: AuthenticationCreds; keys: SignalKeyStore };
  saveCreds(): Promise<void>;
  clear(): Promise<void>;
}
export function linkedAuthState(db: Db, key: Buffer, numberId: string): Promise<LinkedAuthState>;
```

Task 4's socket takes the `state` straight into `makeWASocket({ auth: state })` and calls `saveCreds` on `creds.update`.

## What this replaces

Baileys ships `useMultiFileAuthState` as the reference implementation: one JSON file per key under a directory. This is the same contract against a table, so a container that is recreated does not lose the pairing, and so the session is encrypted at rest like every other credential in this product.

## Steps

- [ ] **Step 1: Write the failing test**

Create `server/test/linked-auth-state.test.ts`:

```ts
import { initAuthCreds } from '@whiskeysockets/baileys';
import { describe, expect, it } from 'vitest';
import { linkedSessionKeys } from '../src/db/schema.js';
import { linkedAuthState } from '../src/lib/whatsapp/linked/auth-state.js';
import { withDb } from './helpers/db.js';

describe('linked auth state', () => {
  it('starts empty and hands back fresh credentials', async () => {
    await withDb(async (db, ids, key) => {
      const auth = await linkedAuthState(db, key, ids.numberId);
      expect(auth.state.creds.registered).toBe(false);
    });
  });

  it('round-trips credentials through the table', async () => {
    await withDb(async (db, ids, key) => {
      const first = await linkedAuthState(db, key, ids.numberId);
      first.state.creds.me = { id: '77000000000@s.whatsapp.net', name: 'Sealhouse' };
      await first.saveCreds();

      const second = await linkedAuthState(db, key, ids.numberId);
      expect(second.state.creds.me?.id).toBe('77000000000@s.whatsapp.net');
    });
  });

  it('round-trips signal keys, including Buffers', async () => {
    await withDb(async (db, ids, key) => {
      const auth = await linkedAuthState(db, key, ids.numberId);
      await auth.state.keys.set({ 'pre-key': { '7': { public: Buffer.from([1, 2, 3]) } } as never });

      const reopened = await linkedAuthState(db, key, ids.numberId);
      const got = await reopened.state.keys.get('pre-key', ['7']);
      expect(Buffer.isBuffer((got['7'] as { public: Buffer }).public)).toBe(true);
      expect((got['7'] as { public: Buffer }).public).toEqual(Buffer.from([1, 2, 3]));
    });
  });

  it('deletes a key when its value is null', async () => {
    await withDb(async (db, ids, key) => {
      const auth = await linkedAuthState(db, key, ids.numberId);
      await auth.state.keys.set({ 'pre-key': { '7': { public: Buffer.from([1]) } } as never });
      await auth.state.keys.set({ 'pre-key': { '7': null } as never });
      const got = await auth.state.keys.get('pre-key', ['7']);
      expect(got['7']).toBeUndefined();
    });
  });

  it('stores nothing a database reader can use', async () => {
    await withDb(async (db, ids, key) => {
      const auth = await linkedAuthState(db, key, ids.numberId);
      auth.state.creds.me = { id: '77000000000@s.whatsapp.net', name: 'Sealhouse' };
      await auth.saveCreds();
      const [row] = await db.select().from(linkedSessionKeys);
      expect(row!.value).not.toContain('77000000000');
    });
  });

  it('clear removes every row for the number', async () => {
    await withDb(async (db, ids, key) => {
      const auth = await linkedAuthState(db, key, ids.numberId);
      await auth.saveCreds();
      await auth.clear();
      expect(await db.select().from(linkedSessionKeys)).toHaveLength(0);
    });
  });
});
```

`withDb` is whatever `server/test/helpers/db.ts` already provides; extend it to seed a `linked` number and to hand back a credentials key rather than writing that setup six times.

- [ ] **Step 2: Run it and watch it fail**

```bash
npm --prefix server test -- linked-auth-state
```

Expected: module not found.

- [ ] **Step 3: Implement**

Create `server/src/lib/whatsapp/linked/auth-state.ts`. The whole file is about forty lines of real work; the shape is:

```ts
import { BufferJSON, initAuthCreds } from '@whiskeysockets/baileys';
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../../../db/client.js';
import { linkedSessionKeys } from '../../../db/schema.js';
import { decryptSecret, encryptSecret } from '../../secret-box.js';

/** `creds` is a category with exactly one member; this is its id. */
const CREDS_ID = 'me';

const encode = (value: unknown) => JSON.stringify(value, BufferJSON.replacer);
const decode = (raw: string) => JSON.parse(raw, BufferJSON.reviver);
```

Points that are easy to get wrong and are what the tests above are for:

- **`BufferJSON` is not optional.** Signal keys are `Buffer`s; `JSON.stringify` without the replacer turns them into `{"type":"Buffer","data":[…]}` and the reviver is what turns them back. A session that round-trips as plain objects fails at the first message with an opaque crypto error.
- **The AAD for `encryptSecret` is the row's identity** — use `` `${numberId}:${category}:${keyId}` `` — so a row copied from one number to another fails to decrypt instead of silently working.
- **`keys.get(type, ids)` is one query**, `inArray(linkedSessionKeys.keyId, ids)`, not one query per id. Baileys asks for dozens at a time.
- **`keys.set(data)` writes and deletes in one pass**: a `null` value means delete that key. Use one `insert … onConflictDoUpdate` per surviving entry and one `delete … where inArray(...)` for the nulls.
- **A row that fails to decrypt is a lost session, not a crash.** Log it, treat the key as absent; `connection.update` will then ask for a new pairing, which is the honest outcome.

- [ ] **Step 4: Run the test**

```bash
npm --prefix server test -- linked-auth-state
```

Expected: PASS, six tests.

- [ ] **Step 5: Full suite and commit**

```bash
npm --prefix server test && npm --prefix server run typecheck
git add -A && git commit -F - <<'MSG'
Keep a linked device's session in Postgres, encrypted

Baileys ships a file-per-key reference implementation; this is the same
contract against a table, so recreating the container does not lose the
pairing and the session is encrypted at rest like every other credential.
Buffers survive the round trip through BufferJSON, and a row that cannot be
decrypted is treated as an absent key rather than a crash: the next connection
asks for a new pairing, which is the truth.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```
