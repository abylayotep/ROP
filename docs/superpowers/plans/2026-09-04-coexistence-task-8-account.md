# Task 8: Webhook — account updates (offboard and reconnect)

Part of [WhatsApp Coexistence](2026-09-04-whatsapp-coexistence.md). Depends on Task 6.

**Files:**
- Modify: `server/src/lib/whatsapp/inbound.ts` (`applyPayload` routes `account_update` by WABA, not by phone)
- Test: `server/test/whatsapp-coexistence-inbound.test.ts` (new `describe`)

**Interfaces:**
- Produces: `applyAccountUpdate(db, wabaId: string, value: AccountUpdateValue): Promise<void>`.

`account_update` is the one field whose payload has no `metadata.phone_number_id`: it is about the WABA, and `entry[].id` is the WABA id. So it is routed before the phone lookup.

- [ ] **Step 1: Failing tests**

Append to `server/test/whatsapp-coexistence-inbound.test.ts`:

```ts
describe('account updates from Meta', () => {
  const update = (event: string, extra: Record<string, unknown> = {}) => ({
    object: 'whatsapp_business_account',
    entry: [{ id: '932', changes: [{ field: 'account_update', value: { event, ...extra } }] }],
  });

  it('disables the number when the phone disconnected the API', async () => {
    await store(update('PARTNER_REMOVED', { disconnection_info: { reason: 'ACCOUNT_DISCONNECTED', initiated_by: 'BUSINESS' } }));

    expect(await processPendingEvents(db, deps())).toEqual({ processed: 1, failed: 0 });

    const [number] = await db.select().from(whatsappNumbers);
    expect(number!.enabled).toBe(false);
    expect(number!.offboardedAt).not.toBeNull();
  });

  it('treats ACCOUNT_OFFBOARDED the same way', async () => {
    await store(update('ACCOUNT_OFFBOARDED'));
    await processPendingEvents(db, deps());

    const [number] = await db.select().from(whatsappNumbers);
    expect(number!.offboardedAt).not.toBeNull();
  });

  it('re-enables on reconnect', async () => {
    await db.update(whatsappNumbers).set({ enabled: false, offboardedAt: new Date() }).where(eq(whatsappNumbers.id, numberId));
    await store(update('ACCOUNT_RECONNECTED'));

    await processPendingEvents(db, deps());

    const [number] = await db.select().from(whatsappNumbers);
    expect(number!).toMatchObject({ enabled: true, offboardedAt: null });
  });

  it('ignores a WABA it does not host and an event it does not know', async () => {
    await store({ object: 'whatsapp_business_account', entry: [{ id: '999', changes: [{ field: 'account_update', value: { event: 'PARTNER_REMOVED' } }] }] });
    await store(update('VERIFIED_ACCOUNT'));

    expect(await processPendingEvents(db, deps())).toEqual({ processed: 2, failed: 0 });

    const [number] = await db.select().from(whatsappNumbers);
    expect(number!).toMatchObject({ enabled: true, offboardedAt: null });
  });
});
```

- [ ] **Step 2: Run, expect failure**

`npm --prefix server test -- coexistence-inbound` → the number stays enabled.

- [ ] **Step 3: Route and apply**

In `inbound.ts`, in `applyPayload`'s inner loop, before calling `applyChange`:

```ts
      if (field === 'account_update') {
        const wabaId = (entry as { id?: string }).id;
        if (wabaId) await applyAccountUpdate(db, wabaId, (value ?? {}) as AccountUpdateValue);
        continue;
      }
```

Add the shape and the handler:

```ts
interface AccountUpdateValue {
  event?: string;
  disconnection_info?: { reason?: string; initiated_by?: string };
}

/**
 * Meta's word on whether the phone still lets us in.
 *
 * Coexistence has no deregister call: the owner disconnects on the phone, Meta tells us
 * here, and until they reconnect every send would fail. Disabling the number keeps the
 * cabinet honest — the composer says why — and the row, with its conversations and click
 * ids, stays for when they come back. Every number on the WABA is affected: the event is
 * about the account, not one phone.
 */
async function applyAccountUpdate(db: Db, wabaId: string, value: AccountUpdateValue): Promise<void> {
  switch (value.event) {
    case 'PARTNER_REMOVED':
    case 'ACCOUNT_OFFBOARDED':
      await db
        .update(whatsappNumbers)
        .set({ enabled: false, offboardedAt: sql`coalesce(${whatsappNumbers.offboardedAt}, now())` })
        .where(and(eq(whatsappNumbers.wabaId, wabaId), eq(whatsappNumbers.connectionKind, 'coexistence')));
      return;
    case 'ACCOUNT_RECONNECTED':
      await db
        .update(whatsappNumbers)
        .set({ enabled: true, offboardedAt: null })
        .where(and(eq(whatsappNumbers.wabaId, wabaId), eq(whatsappNumbers.connectionKind, 'coexistence')));
      return;
    default:
      return;
  }
}
```

The manual-kind filter keeps a pasted-token number on the same WABA untouched: Meta's offboard event is about the phone's companion, not about the system-user token.

- [ ] **Step 4: Run everything**

```bash
npm --prefix server test
npm --prefix server run typecheck
```

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add server/src/lib/whatsapp/inbound.ts server/test/whatsapp-coexistence-inbound.test.ts
git commit -m "Follow the phone when it disconnects or reconnects the API"
```
