# Task 6: Webhook — message echoes and phone contacts

Part of [WhatsApp Coexistence](2026-09-04-whatsapp-coexistence.md). Depends on Task 3.

**Files:**
- Modify: `server/src/lib/whatsapp/inbound.ts` (`applyPayload` passes `field`; `applyChange` routes on it; two new handlers)
- Test: `server/test/whatsapp-coexistence-inbound.test.ts` (new)

**Interfaces:**
- Produces: `applyChange(db, deps, field: string, value: ChangeValue, touched)`; exported `applyEchoes` and `applyContactSync` are internal — tests drive them through `processPendingEvents`.
- Task 7 and Task 8 add their own branches to the same `switch`.

- [ ] **Step 1: Failing tests**

Create `server/test/whatsapp-coexistence-inbound.test.ts`:

```ts
import { rm } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agents, contacts, conversations, messages, whatsappEvents, whatsappNumbers } from '../src/db/schema.js';
import { createAccountWithOwner } from '../src/lib/provision.js';
import { encryptSecret } from '../src/lib/secret-box.js';
import { processPendingEvents } from '../src/lib/whatsapp/inbound.js';
import { withDb } from './helpers/db.js';
import { testEnv } from './helpers/env.js';
import { fakeGraph } from './helpers/fake-graph.js';
import { fakeModel, type FakeModel } from './helpers/fake-model.js';

const env = testEnv();
const key = Buffer.from(env.CREDENTIALS_KEY, 'base64');

let db: Awaited<ReturnType<typeof withDb>>;
let agentId: string;
let numberId: string;
let model: FakeModel;

const deps = () => ({ graph: fakeGraph(), key, mediaDir: env.MEDIA_DIR, model });

beforeEach(async () => {
  db = await withDb();
  model = fakeModel();
  const { accountId } = await createAccountWithOwner(db, {
    company: 'Sealhouse',
    email: 'owner@example.com',
    name: 'Владелец',
    initials: 'ВЛ',
    password: 'correct-horse-battery',
  });
  const [agent] = await db.insert(agents).values({ accountId, name: 'Sealhouse' }).returning();
  agentId = agent!.id;
  const [number] = await db
    .insert(whatsappNumbers)
    .values({
      agentId,
      phoneNumberId: '136',
      wabaId: '932',
      displayPhone: '+7 771 523 03 42',
      accessToken: encryptSecret('EAAB-token', key, '136'),
      connectionKind: 'coexistence',
    })
    .returning();
  numberId = number!.id;
});

afterEach(async () => {
  await rm(env.MEDIA_DIR, { recursive: true, force: true });
});

/** One delivery of one change, in the envelope Meta uses for every field. */
export const change = (field: string, value: Record<string, unknown>) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: '932', changes: [{ field, value }] }],
});

const meta = { messaging_product: 'whatsapp', metadata: { display_phone_number: '77715230342', phone_number_id: '136' } };

const store = (payload: unknown) => db.insert(whatsappEvents).values({ payload });

const echo = (id = 'wamid.ECHO', body = 'Доставим завтра') =>
  change('smb_message_echoes', {
    ...meta,
    message_echoes: [{ from: '77715230342', to: '77771234567', id, timestamp: '1756000100', type: 'text', text: { body } }],
  });

describe('a message the operator sent from the phone', () => {
  it('is stored as an outbound message by the phone and silences the AI on that thread', async () => {
    await store(echo());

    expect(await processPendingEvents(db, deps())).toEqual({ processed: 1, failed: 0 });

    const [contact] = await db.select().from(contacts);
    expect(contact).toMatchObject({ agentId, phone: '77771234567' });
    const [conversation] = await db.select().from(conversations);
    expect(conversation).toMatchObject({ whatsappNumberId: numberId, aiEnabled: false, lastInboundAt: null });
    expect(conversation!.lastMessageAt?.toISOString()).toBe('2025-08-24T01:48:20.000Z');
    const [message] = await db.select().from(messages);
    expect(message).toMatchObject({ waMessageId: 'wamid.ECHO', direction: 'out', author: 'phone', kind: 'text', body: 'Доставим завтра', status: 'sent' });
    expect(model.calls).toHaveLength(0);
  });

  it('is stored once when delivered twice', async () => {
    await store(echo());
    await store(echo());

    await processPendingEvents(db, deps());

    expect(await db.select().from(messages)).toHaveLength(1);
  });

  it('does not open a reply window', async () => {
    await store(echo());
    await processPendingEvents(db, deps());

    const [conversation] = await db.select().from(conversations);
    expect(conversation!.lastInboundAt).toBeNull();
  });
});

describe('contacts synced from the phone', () => {
  const sync = (action: 'add' | 'remove', name?: string) =>
    change('smb_app_state_sync', {
      ...meta,
      state_sync: [
        {
          type: 'contact',
          contact: name ? { full_name: name, first_name: name.split(' ')[0], phone_number: '+7 777 123 45 67' } : { phone_number: '+7 777 123 45 67' },
          action,
          metadata: { timestamp: '1756000200' },
        },
      ],
    });

  it('creates a contact with the phone-book name', async () => {
    await store(sync('add', 'Айгерім Клиент'));

    await processPendingEvents(db, deps());

    const [contact] = await db.select().from(contacts);
    expect(contact).toMatchObject({ phone: '77771234567', name: 'Айгерім Клиент' });
    expect(await db.select().from(conversations)).toHaveLength(0);
  });

  it('does not overwrite a name the cabinet already holds', async () => {
    await db.insert(contacts).values({ agentId, phone: '77771234567', name: 'Айгерім (оптовик)' });
    await store(sync('add', 'Айгерім Клиент'));

    await processPendingEvents(db, deps());

    const [contact] = await db.select().from(contacts).where(eq(contacts.phone, '77771234567'));
    expect(contact!.name).toBe('Айгерім (оптовик)');
  });

  it('keeps the contact when the phone removes it', async () => {
    await db.insert(contacts).values({ agentId, phone: '77771234567', name: 'Айгерім' });
    await store(sync('remove'));

    await processPendingEvents(db, deps());

    expect(await db.select().from(contacts)).toHaveLength(1);
  });
});
```

The `fakeModel` helper must expose `calls`; check `server/test/helpers/fake-model.ts` and use whatever it records (the AI inbound tests already assert on it — copy their access pattern if the name differs).

- [ ] **Step 2: Run, expect failure**

`npm --prefix server test -- coexistence-inbound` → echoes are ignored: no message stored.

- [ ] **Step 3: Route by field**

In `server/src/lib/whatsapp/inbound.ts`, extend `ChangeValue` and add two shapes near it:

```ts
/** A message the operator sent from the WhatsApp Business app. Same fields as inbound plus `to`. */
interface EchoMessage extends InboundMessage {
  to: string;
}

interface ContactSync {
  type: string;
  action: 'add' | 'remove';
  contact?: { full_name?: string; first_name?: string; phone_number?: string };
}

interface ChangeValue {
  metadata?: { phone_number_id?: string };
  contacts?: { profile?: { name?: string }; wa_id: string }[];
  messages?: InboundMessage[];
  statuses?: StatusUpdate[];
  message_echoes?: EchoMessage[];
  state_sync?: ContactSync[];
}
```

In `applyPayload`, pass the field:

```ts
    for (const change of changes) {
      const { field, value } = change as { field?: string; value?: ChangeValue };
      errors.push(...(await applyChange(db, deps, field ?? 'messages', value ?? {}, touched)));
    }
```

Rename today's body of `applyChange` to `applyMessages(db, deps, number, value, touched)` (it keeps everything from the `statuses` loop down and returns `errors`), and make `applyChange` the router:

```ts
async function applyChange(
  db: Db,
  deps: InboundDeps,
  field: string,
  value: ChangeValue,
  touched: Touched,
): Promise<string[]> {
  const phoneNumberId = value.metadata?.phone_number_id;
  if (!phoneNumberId) return [];

  const [number] = await db.select().from(whatsappNumbers).where(eq(whatsappNumbers.phoneNumberId, phoneNumberId));
  // Not an error: one Meta application serves every client, and a delivery about a number
  // we do not host is simply not ours.
  if (!number) return [];

  switch (field) {
    case 'messages':
      return applyMessages(db, deps, number, value, touched);
    case 'smb_message_echoes':
      return applyEchoes(db, deps, number, value.message_echoes ?? []);
    case 'smb_app_state_sync':
      await applyContactSync(db, number.agentId, value.state_sync ?? []);
      return [];
    default:
      // A field we did not subscribe to, or one a later stage will handle. Stored already;
      // nothing to do.
      return [];
  }
}
```

`number` is `typeof whatsappNumbers.$inferSelect`; give it a local alias `type NumberRow = typeof whatsappNumbers.$inferSelect;`.

- [ ] **Step 4: Echoes**

Below `applyMessages`:

```ts
/** Digits only, the shape `wa_id` uses. Meta's contact sync sends `+7 777 …` with spaces. */
const digits = (phone: string) => phone.replace(/\D/g, '');

/**
 * What the operator said from the phone. Stored so the thread in the cabinet is whole, and
 * treated as the operator taking the thread: the agent stops answering here until someone in
 * the cabinet turns it back on. No turn runs — a customer was just answered by a human.
 *
 * `last_inbound_at` is not touched: an app-sent message does not open a reply window, and
 * pretending it did would let the cabinet send a free-form reply Meta will refuse.
 */
async function applyEchoes(
  db: Db,
  deps: InboundDeps,
  number: NumberRow,
  echoes: EchoMessage[],
): Promise<string[]> {
  const errors: string[] = [];
  for (const echo of echoes) {
    const contactId = await upsertContact(db, number.agentId, digits(echo.to), undefined);
    const conversationId = await upsertConversation(db, number.agentId, number.id, contactId);

    const [known] = await db.select({ id: messages.id }).from(messages).where(eq(messages.waMessageId, echo.id));
    let media: { path: string; mime: string } | null = null;
    const mediaId = mediaIdOf(echo);
    if (mediaId && !known) {
      let token = '';
      try {
        token = decryptSecret(number.accessToken, deps.key, number.phoneNumberId);
        media = await downloadInboundMedia(deps, { mediaId, token, agentId: number.agentId, waMessageId: echo.id });
      } catch (error) {
        errors.push(withoutSecret(error instanceof Error ? error.message : String(error), token));
      }
    }

    await db
      .insert(messages)
      .values({
        conversationId,
        waMessageId: echo.id,
        direction: 'out',
        author: 'phone',
        kind: echo.type,
        body: bodyOf(echo),
        status: 'sent',
        sentAt: at(echo.timestamp),
        mediaPath: media?.path ?? null,
        mediaMime: media?.mime ?? null,
      })
      .onConflictDoNothing({ target: messages.waMessageId });

    const sentAtParam = sql`${at(echo.timestamp).toISOString()}::timestamptz`;
    await db
      .update(conversations)
      .set({
        aiEnabled: false,
        lastMessageAt: sql`greatest(coalesce(${conversations.lastMessageAt}, to_timestamp(0)), ${sentAtParam})`,
      })
      .where(eq(conversations.id, conversationId));
  }
  return errors;
}

/**
 * The phone's address book, as Meta streams it after onboarding and on every edit.
 *
 * `add` covers edits too. A name typed in the cabinet wins over the phone-book entry, so the
 * upsert fills only a null name. `remove` changes nothing: the person may still write, and
 * what they said is ours to keep.
 */
async function applyContactSync(db: Db, agentId: string, items: ContactSync[]): Promise<void> {
  for (const item of items) {
    if (item.type !== 'contact' || item.action !== 'add') continue;
    const phone = digits(item.contact?.phone_number ?? '');
    if (!phone) continue;
    const name = item.contact?.full_name?.trim() || item.contact?.first_name?.trim() || null;
    await db
      .insert(contacts)
      .values({ agentId, phone, name })
      .onConflictDoUpdate({
        target: [contacts.agentId, contacts.phone],
        set: { name: sql`coalesce(${contacts.name}, ${name})` },
      });
  }
}
```

`bodyOf` and `mediaIdOf` take an `InboundMessage`; `EchoMessage` extends it, so they accept an echo unchanged.

- [ ] **Step 5: Run everything**

```bash
npm --prefix server test
npm --prefix server run typecheck
```

Expected: green, including `whatsapp-inbound.test.ts` and `ai-inbound.test.ts`, whose deliveries carry `field: 'messages'`. If one of those helpers omits `field`, the `?? 'messages'` default covers it.

- [ ] **Step 6: Commit**

```bash
git add server/src/lib/whatsapp/inbound.ts server/test/whatsapp-coexistence-inbound.test.ts
git commit -m "Mirror what the operator sends from the phone and import its contacts"
```
