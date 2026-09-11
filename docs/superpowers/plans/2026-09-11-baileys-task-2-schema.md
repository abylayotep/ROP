# Task 2: Dependency, schema, migration, contract

**Files:**
- Modify: `server/package.json`, `server/src/db/schema.ts`, `packages/contract/index.ts`, `server/src/api/whatsapp-numbers.ts`
- Create: `server/drizzle/00NN_*.sql` (generated), `server/test/linked-schema.test.ts`

**Interfaces:**
- Consumes: Task 1's merged schema.
- Produces: `whatsappNumbers.connectionKind` accepting `'linked'`; `whatsappNumbers.linkedJid: text | null`; `whatsappNumbers.linkedState: text | null`; the `linkedSessionKeys` table with columns `whatsappNumberId`, `category`, `keyId`, `value`, `updatedAt` and primary key `(whatsappNumberId, category, keyId)`; contract type `WhatsappNumber.linkedState: 'pairing' | 'open' | 'logged_out' | null`.

## Steps

- [ ] **Step 1: Add the dependency, pinned**

```bash
npm --prefix server install --cache "$TMPDIR/npm-cache" --save-exact @whiskeysockets/baileys@6.7.24
```

Verify `server/package.json` reads `"@whiskeysockets/baileys": "6.7.24"` with no caret.

- [ ] **Step 2: Confirm the export shape before any code depends on it**

```bash
node --input-type=module -e "import * as b from '@whiskeysockets/baileys'; console.log(typeof b.default, Object.keys(b).filter(k => /^(initAuthCreds|BufferJSON|DisconnectReason|downloadMediaMessage|makeWASocket)$/.test(k)).sort().join(','))" --experimental-loader= 2>/dev/null || node -e "const b=require('@whiskeysockets/baileys');console.log(Object.keys(b).filter(k=>/^(initAuthCreds|BufferJSON|DisconnectReason|downloadMediaMessage|makeWASocket|default)$/.test(k)).sort().join(','))"
```

Expected: `initAuthCreds`, `BufferJSON`, `DisconnectReason`, `downloadMediaMessage` are all present, and the socket factory is the default export. Write down what you actually saw — Tasks 3 and 4 import exactly these names, and a mismatch here is cheaper to find now than inside a socket.

- [ ] **Step 3: Write the failing schema test**

Create `server/test/linked-schema.test.ts`. It uses the migration database helper the other schema tests use (`server/test/helpers/migration-db.ts`) so the assertions run against real DDL, not against the Drizzle objects.

```ts
import { describe, expect, it } from 'vitest';
import { withMigratedDb } from './helpers/migration-db.js';

describe('linked numbers schema', () => {
  it('accepts a linked number with no Cloud API columns', async () => {
    await withMigratedDb(async (sql, ids) => {
      await sql`insert into whatsapp_numbers
        (agent_id, display_phone, connection_kind, linked_jid, linked_state)
        values (${ids.agentId}, '+7 700 000 00 00', 'linked', '77000000000@s.whatsapp.net', 'open')`;
      const [row] = await sql`select connection_kind, phone_number_id from whatsapp_numbers`;
      expect(row).toMatchObject({ connection_kind: 'linked', phone_number_id: null });
    });
  });

  it('refuses a linked number without a jid', async () => {
    await withMigratedDb(async (sql, ids) => {
      await expect(
        sql`insert into whatsapp_numbers (agent_id, display_phone, connection_kind, linked_state)
            values (${ids.agentId}, '+7 700 000 00 00', 'linked', 'open')`,
      ).rejects.toThrow();
    });
  });

  it('refuses a manual number without a token', async () => {
    await withMigratedDb(async (sql, ids) => {
      await expect(
        sql`insert into whatsapp_numbers (agent_id, display_phone, connection_kind, phone_number_id, waba_id)
            values (${ids.agentId}, '+7 700 000 00 00', 'manual', '1', '2')`,
      ).rejects.toThrow();
    });
  });

  it('lets two linked numbers coexist, each with a null phone_number_id', async () => {
    await withMigratedDb(async (sql, ids) => {
      for (const jid of ['77000000001@s.whatsapp.net', '77000000002@s.whatsapp.net']) {
        await sql`insert into whatsapp_numbers
          (agent_id, display_phone, connection_kind, linked_jid, linked_state)
          values (${ids.agentId}, ${jid}, 'linked', ${jid}, 'open')`;
      }
      const [{ count }] = await sql`select count(*)::int as count from whatsapp_numbers`;
      expect(count).toBe(2);
    });
  });
});
```

Read `server/test/helpers/migration-db.ts` first and match its actual signature; if it does not already hand back seeded ids, extend it rather than seeding inline in four places.

- [ ] **Step 4: Run it and watch it fail**

```bash
npm --prefix server test -- linked-schema
```

Expected: failures on the unknown columns `linked_jid` and `linked_state`.

- [ ] **Step 5: Change the schema**

In `server/src/db/schema.ts`, on `whatsappNumbers`:

```ts
    // 'manual' — ids and a system-user token pasted by the owner (stage 2).
    // 'coexistence' — the phone's own number through Embedded Signup (stage 7).
    // 'linked' — the phone's own number through a linked device, no Meta at all (stage 8).
    connectionKind: text('connection_kind').notNull().default('manual'),
    // Linked only: the number's own id inside WhatsApp, and how the pairing stands.
    // A linked number has no phone_number_id, no WABA and no access token, which is why
    // all three became nullable when this kind arrived.
    linkedJid: text('linked_jid'),
    linkedState: text('linked_state'),
```

and make `phoneNumberId`, `wabaId`, `accessToken` nullable by dropping `.notNull()`. Replace `.unique()` on `phoneNumberId` with a partial unique index in the table's second argument:

```ts
    uniqueIndex('whatsapp_numbers_phone_number_id_key')
      .on(t.phoneNumberId)
      .where(sql`${t.phoneNumberId} is not null`),
```

Add the new table below `whatsappNumbers`:

```ts
/**
 * One entry of a linked device's Baileys session.
 *
 * A row per key rather than one blob per number: the key store is written on almost every
 * message, and rewriting the whole session each time would make a busy number the busiest
 * writer in the database. `value` is encrypted with the credentials key, the same way an
 * access token is — a session is the ability to send as the owner.
 */
export const linkedSessionKeys = pgTable(
  'linked_session_keys',
  {
    whatsappNumberId: uuid('whatsapp_number_id')
      .notNull()
      .references(() => whatsappNumbers.id, { onDelete: 'cascade' }),
    // Baileys' own key type: 'creds', 'pre-key', 'session', 'sender-key', 'app-state-sync-key', …
    category: text('category').notNull(),
    // Identity inside the category. 'creds' stores a single row under the id 'me'.
    keyId: text('key_id').notNull(),
    value: text('value').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.whatsappNumberId, t.category, t.keyId] })],
);
```

- [ ] **Step 6: Generate the migration and add the two checks by hand**

```bash
npm --prefix server run generate
```

drizzle-kit does not write check constraints for this shape. Append them to the generated file:

```sql
ALTER TABLE "whatsapp_numbers" ADD CONSTRAINT "whatsapp_numbers_cloud_columns_check"
  CHECK (
    connection_kind = 'linked'
    OR (phone_number_id IS NOT NULL AND waba_id IS NOT NULL AND access_token IS NOT NULL)
  );
ALTER TABLE "whatsapp_numbers" ADD CONSTRAINT "whatsapp_numbers_linked_columns_check"
  CHECK (
    connection_kind <> 'linked'
    OR (linked_jid IS NOT NULL AND linked_state IS NOT NULL)
  );
```

- [ ] **Step 7: Run the test and the suite**

```bash
DATABASE_URL=postgres://rakurs:rakurs@localhost:55433/rakurs_dev npm --prefix server run migrate
npm --prefix server test -- linked-schema
npm --prefix server test
npm --prefix server run typecheck
```

`whatsapp-numbers.test.ts` and the coexistence tests will fail to typecheck where they read `number.phoneNumberId` as `string`. Fix them at the call site with the narrowing the code already implies — inside a `manual`/`coexistence` branch the column is non-null — never with `!`.

- [ ] **Step 8: Widen the contract**

In `packages/contract/index.ts`, `WhatsappNumber`:

```ts
  /** 'manual' | 'coexistence' | 'linked'. */
  connectionKind: string;
  /** A Cloud API number has none of these. */
  phoneNumberId: string | null;
  wabaId: string | null;
  /** Linked only: 'pairing' | 'open' | 'logged_out'. Null for the Cloud API kinds. */
  linkedState: string | null;
```

Update `toApi` in `server/src/api/whatsapp-numbers.ts` to carry the two new values.

- [ ] **Step 9: Green everything and commit**

```bash
npm --prefix server test && npm --prefix server run typecheck
npm --prefix rakurs run typecheck && npm --prefix rakurs run build
git add -A && git commit -F - <<'MSG'
Give a WhatsApp number a linked kind and a place to keep its session

A linked device has no phone number id, no WABA and no access token, so the
three columns that carried them become nullable and their uniqueness becomes
partial. Two check constraints keep a half-filled row of either kind out of the
table, where it would otherwise surface hours later as a refused send.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```
