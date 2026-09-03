# Task 3: Schema, migration, contract

Part of [WhatsApp Coexistence](2026-09-04-whatsapp-coexistence.md). Depends on Task 2.

**Files:**
- Modify: `server/src/db/schema.ts:128-147` (`whatsappNumbers`), `server/src/db/schema.ts:232` (comment on `author`)
- Create: `server/drizzle/0011_<generated>.sql` via `npm --prefix server run generate`
- Modify: `packages/contract/index.ts:39-55`
- Modify: `server/src/api/whatsapp-numbers.ts:34-42` (`toApi`)
- Test: `server/test/whatsapp-schema.test.ts`

**Interfaces:**
- Produces on `whatsappNumbers`: `connectionKind` (`'manual' | 'coexistence'`, default `'manual'`), `businessId: string | null`, `syncRequestedAt: Date | null`, `syncError: string | null`, `historyProgress: number` (default 0), `historyDeclinedAt: Date | null`, `offboardedAt: Date | null`.
- Produces in the contract: `WhatsappNumber.connectionKind: 'manual' | 'coexistence'`, `.historyProgress: number`, `.historyDeclined: boolean`, `.syncError: string | null`, `.offboarded: boolean`; `EmbeddedSignupSetup { appId: string; configId: string }`; `CoexistenceConnection { code: string; wabaId: string; phoneNumberId?: string; businessId?: string }`.

- [ ] **Step 1: Failing schema test**

Append to `server/test/whatsapp-schema.test.ts`:

```ts
describe('coexistence columns', () => {
  it('defaults a number to the manual kind with no sync state', async () => {
    const number = await seedNumber();

    expect(number).toMatchObject({
      connectionKind: 'manual',
      businessId: null,
      syncRequestedAt: null,
      syncError: null,
      historyProgress: 0,
      historyDeclinedAt: null,
      offboardedAt: null,
    });
  });

  it('stores a coexistence number with its portfolio', async () => {
    const [row] = await db
      .insert(whatsappNumbers)
      .values({
        agentId,
        phoneNumberId: '555',
        wabaId: '932647766535299',
        displayPhone: '+7 771 523 03 42',
        accessToken: 'encrypted',
        connectionKind: 'coexistence',
        businessId: '877624983685944',
        historyProgress: 55,
      })
      .returning();

    expect(row).toMatchObject({ connectionKind: 'coexistence', historyProgress: 55 });
  });
});
```

- [ ] **Step 2: Run, expect failure**

`npm --prefix server test -- whatsapp-schema` → TypeScript rejects `connectionKind` on the insert.

- [ ] **Step 3: Columns**

In `server/src/db/schema.ts`, inside `whatsappNumbers` after `subscribedAt`:

```ts
    // 'manual' — ids and a system-user token pasted by the owner (stage 2).
    // 'coexistence' — the phone's own number, onboarded through Embedded Signup; the token
    // came from Meta, registration was skipped, and the phone keeps working (stage 7).
    connectionKind: text('connection_kind').notNull().default('manual'),
    // The customer's business portfolio id, as Embedded Signup reported it. Informational.
    businessId: text('business_id'),
    // Both one-shot `smb_app_data` requests were accepted. Null with `syncError` set means
    // at least one was refused; Meta allows each exactly once, so nothing retries them.
    syncRequestedAt: timestamp('sync_requested_at', { withTimezone: true }),
    syncError: text('sync_error'),
    // 0..100 from `history.metadata.progress`; only ever grows.
    historyProgress: integer('history_progress').notNull().default(0),
    // Meta reported error 2593109: the owner turned history sharing off on the phone.
    historyDeclinedAt: timestamp('history_declined_at', { withTimezone: true }),
    // `account_update` said the phone disconnected the API. Cleared on reconnect.
    offboardedAt: timestamp('offboarded_at', { withTimezone: true }),
```

Add `integer` to the `drizzle-orm/pg-core` import if it is not there. Change the comment on `messages.author` to:

```ts
    // 'client' | 'operator' | 'ai' | 'system' | 'phone' — 'phone' is the operator answering
    // from the WhatsApp Business app; the cabinet only ever sees its echo.
```

- [ ] **Step 4: Generate the migration**

```bash
npm --prefix server run generate
```

Expected: a new `server/drizzle/0011_*.sql` containing seven `ALTER TABLE "whatsapp_numbers" ADD COLUMN` statements. Open it and check `connection_kind` has `DEFAULT 'manual' NOT NULL` and `history_progress` has `DEFAULT 0 NOT NULL`.

- [ ] **Step 5: Contract**

In `packages/contract/index.ts`, replace `WhatsappNumber` and add two types after `WebhookSetup`:

```ts
export interface WhatsappNumber {
  id: string;
  phoneNumberId: string;
  wabaId: string;
  /** As Meta formats it, for a human to recognise. */
  displayPhone: string;
  enabled: boolean;
  /** False means Meta accepted the number but will not deliver anything yet. */
  subscribed: boolean;
  connectedAt: string;
  /** 'manual' — pasted ids and token. 'coexistence' — the phone's number via Embedded Signup. */
  connectionKind: 'manual' | 'coexistence';
  /** 0..100. Meaningful for coexistence only; manual numbers stay at 0. */
  historyProgress: number;
  /** The owner turned history sharing off on the phone. */
  historyDeclined: boolean;
  /** Meta's words when a sync request was refused, else null. */
  syncError: string | null;
  /** The phone disconnected the API; reconnect happens on the phone, not here. */
  offboarded: boolean;
}

/** What the browser needs to start Embedded Signup. Nothing secret. */
export interface EmbeddedSignupSetup {
  appId: string;
  configId: string;
}

/** What Embedded Signup hands back, forwarded to the server within the code's 30 seconds. */
export interface CoexistenceConnection {
  code: string;
  wabaId: string;
  phoneNumberId?: string;
  businessId?: string;
}
```

- [ ] **Step 6: `toApi`**

In `server/src/api/whatsapp-numbers.ts` replace `toApi`:

```ts
const toApi = (row: typeof whatsappNumbers.$inferSelect): WhatsappNumber => ({
  id: row.id,
  phoneNumberId: row.phoneNumberId,
  wabaId: row.wabaId,
  displayPhone: row.displayPhone,
  enabled: row.enabled,
  subscribed: row.subscribedAt !== null,
  connectedAt: row.createdAt.toISOString(),
  connectionKind: row.connectionKind === 'coexistence' ? 'coexistence' : 'manual',
  historyProgress: row.historyProgress,
  historyDeclined: row.historyDeclinedAt !== null,
  syncError: row.syncError,
  offboarded: row.offboardedAt !== null,
});
```

Export it: `export const toApi = …` — Task 5 reuses it.

- [ ] **Step 7: Run everything**

```bash
npm --prefix server test
npm --prefix server run typecheck
npm --prefix rakurs run typecheck
```

Expected: green. The frontend compiles because the new fields are additive.

- [ ] **Step 8: Commit**

```bash
git add server/src/db/schema.ts server/drizzle packages/contract/index.ts server/src/api/whatsapp-numbers.ts server/test/whatsapp-schema.test.ts
git commit -m "Give a WhatsApp number a connection kind and coexistence sync state"
```
