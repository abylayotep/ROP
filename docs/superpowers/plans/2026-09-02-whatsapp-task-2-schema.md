# Task 2: Schema and migration

Part of [WhatsApp Cloud API](2026-09-02-whatsapp-cloud-api.md).

The five tables the rest of the stage writes into. Nothing reads them yet; the point of doing
them alone is that the shape gets its own review before eight tasks build on it.

**Files:**
- Modify: `server/src/db/schema.ts`
- Create: `server/drizzle/0002_*.sql` (generated)
- Modify: `server/test/helpers/db.ts`
- Test: `server/test/whatsapp-schema.test.ts`

**Interfaces:**
- Consumes: `agents` from stage 1.
- Produces: the Drizzle tables `whatsappNumbers`, `contacts`, `conversations`, `messages`,
  `whatsappEvents`, exported from `server/src/db/schema.ts`.

---

- [ ] **Step 1: Write the failing test**

Create `server/test/whatsapp-schema.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  agents,
  contacts,
  conversations,
  messages,
  whatsappEvents,
  whatsappNumbers,
} from '../src/db/schema.js';
import { createAccountWithOwner } from '../src/lib/provision.js';
import { withDb } from './helpers/db.js';

let db: Awaited<ReturnType<typeof withDb>>;
let agentId: string;

beforeEach(async () => {
  db = await withDb();
  const { accountId } = await createAccountWithOwner(db, {
    company: 'Сафина',
    email: 'owner@example.com',
    name: 'Владелец',
    initials: 'ВЛ',
    password: 'correct-horse-battery',
  });
  const [agent] = await db.insert(agents).values({ accountId, name: 'Сафина' }).returning();
  agentId = agent!.id;
});

const seedNumber = async () =>
  (
    await db
      .insert(whatsappNumbers)
      .values({
        agentId,
        phoneNumberId: '1367497639773085',
        wabaId: '932647766535299',
        displayPhone: '+7 708 580 79 32',
        accessToken: 'encrypted',
      })
      .returning()
  )[0]!;

describe('whatsapp schema', () => {
  it('defaults a connected number to enabled and unsubscribed', async () => {
    const number = await seedNumber();

    expect(number.enabled).toBe(true);
    expect(number.subscribedAt).toBeNull();
  });

  it('refuses the same phone_number_id twice, whichever agent claims it', async () => {
    await seedNumber();
    const [other] = await db
      .insert(agents)
      .values({ accountId: (await db.select().from(agents))[0]!.accountId, name: 'Второй' })
      .returning();

    // A different agent, the same number. The uniqueness has to be global: an incoming
    // webhook carries only the phone_number_id, so two owners would make routing a guess.
    await expect(
      db.insert(whatsappNumbers).values({
        agentId: other!.id,
        phoneNumberId: '1367497639773085',
        wabaId: '932647766535299',
        displayPhone: '+7 708 580 79 32',
        accessToken: 'encrypted',
      }),
    ).rejects.toThrow();
  });

  it('refuses the same client twice inside one agent', async () => {
    const contact = { agentId, phone: '77771234567' };
    await db.insert(contacts).values(contact);

    await expect(db.insert(contacts).values(contact)).rejects.toThrow();
  });

  it('keeps one conversation per client per number', async () => {
    const number = await seedNumber();
    const [contact] = await db
      .insert(contacts)
      .values({ agentId, phone: '77771234567' })
      .returning();
    const row = { agentId, contactId: contact!.id, whatsappNumberId: number.id };
    await db.insert(conversations).values(row);

    await expect(db.insert(conversations).values(row)).rejects.toThrow();
  });

  it('refuses to store one WhatsApp message id twice', async () => {
    const number = await seedNumber();
    const [contact] = await db
      .insert(contacts)
      .values({ agentId, phone: '77771234567' })
      .returning();
    const [conversation] = await db
      .insert(conversations)
      .values({ agentId, contactId: contact!.id, whatsappNumberId: number.id })
      .returning();
    const message = {
      conversationId: conversation!.id,
      waMessageId: 'wamid.HBgLNzc3NzEyMzQ1NjcVAgAS',
      direction: 'in',
      author: 'client',
      kind: 'text',
      body: 'Сәлеметсіз бе',
      sentAt: new Date(),
    };
    await db.insert(messages).values(message);

    await expect(db.insert(messages).values(message)).rejects.toThrow();
  });

  it('takes a conversation and its messages away with the agent', async () => {
    const number = await seedNumber();
    const [contact] = await db
      .insert(contacts)
      .values({ agentId, phone: '77771234567' })
      .returning();
    const [conversation] = await db
      .insert(conversations)
      .values({ agentId, contactId: contact!.id, whatsappNumberId: number.id })
      .returning();
    await db.insert(messages).values({
      conversationId: conversation!.id,
      waMessageId: 'wamid.one',
      direction: 'in',
      author: 'client',
      kind: 'text',
      body: 'привет',
      sentAt: new Date(),
    });

    await db.delete(agents).where(eq(agents.id, agentId));

    expect(await db.select().from(messages)).toEqual([]);
    expect(await db.select().from(conversations)).toEqual([]);
    expect(await db.select().from(contacts)).toEqual([]);
    expect(await db.select().from(whatsappNumbers)).toEqual([]);
  });

  it('stores a raw event before anyone has parsed it', async () => {
    const [event] = await db
      .insert(whatsappEvents)
      .values({ payload: { object: 'whatsapp_business_account', entry: [] } })
      .returning();

    expect(event!.processedAt).toBeNull();
    expect(event!.error).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm --prefix server test -- whatsapp-schema
```

Expected: FAIL — `whatsappNumbers` is not exported from the schema module.

- [ ] **Step 3: Add the tables**

In `server/src/db/schema.ts`, extend the drizzle import to include `boolean`, `jsonb` and
`unique`, and append:

```ts
/**
 * A WhatsApp number connected through the Cloud API.
 *
 * `phoneNumberId` is unique across the whole product, not per agent: it identifies the number
 * inside Meta, an incoming webhook carries only that, and two agents claiming one number would
 * make the routing ambiguous.
 */
export const whatsappNumbers = pgTable(
  'whatsapp_numbers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    phoneNumberId: text('phone_number_id').notNull().unique(),
    wabaId: text('waba_id').notNull(),
    displayPhone: text('display_phone').notNull(),
    // Encrypted with the credentials key. Never selected into an API response.
    accessToken: text('access_token').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    // Set when Meta confirms our application is subscribed to the WABA. Until then the
    // number is connected but silent, which is the failure this column makes visible.
    subscribedAt: timestamp('subscribed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('whatsapp_numbers_agent_id_idx').on(t.agentId)],
);

/** A person who wrote to us. Digits only, the shape WhatsApp uses in `wa_id`. */
export const contacts = pgTable(
  'contacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    phone: text('phone').notNull(),
    // WhatsApp's profile name. Absent until the person's first message carries it.
    name: text('name'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('contacts_agent_phone_key').on(t.agentId, t.phone)],
);

/**
 * One thread: this client, on this number.
 *
 * The advertising columns are filled once, from the `referral` block on the first message of
 * a conversation that began with a click on an ad. They are what stage 6 reports to Meta, and
 * they cannot be recovered afterwards — the block never appears again.
 */
export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    whatsappNumberId: uuid('whatsapp_number_id')
      .notNull()
      .references(() => whatsappNumbers.id, { onDelete: 'cascade' }),
    // The 24-hour window for a free-form reply is measured from this.
    lastInboundAt: timestamp('last_inbound_at', { withTimezone: true }),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    ctwaClid: text('ctwa_clid'),
    adSourceId: text('ad_source_id'),
    adSourceType: text('ad_source_type'),
    adHeadline: text('ad_headline'),
    adBody: text('ad_body'),
    referralSeenAt: timestamp('referral_seen_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('conversations_number_contact_key').on(t.whatsappNumberId, t.contactId),
    index('conversations_agent_last_message_idx').on(t.agentId, t.lastMessageAt),
  ],
);

/**
 * One message either way.
 *
 * `waMessageId` is unique because Meta delivers the same webhook more than once by design;
 * the index is the whole defence against a duplicated thread.
 */
export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    waMessageId: text('wa_message_id').notNull().unique(),
    // 'in' | 'out'
    direction: text('direction').notNull(),
    // 'client' | 'operator' | 'ai' — stage 5 adds a value here, not a column.
    author: text('author').notNull(),
    // WhatsApp's own type: text, image, audio, video, document, sticker, location,
    // contacts, or unsupported for anything we do not render.
    kind: text('kind').notNull(),
    body: text('body'),
    mediaPath: text('media_path'),
    mediaMime: text('media_mime'),
    // Outbound only: sent, delivered, read, failed.
    status: text('status'),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('messages_conversation_sent_at_idx').on(t.conversationId, t.sentAt)],
);

/**
 * Every webhook delivery, exactly as it arrived.
 *
 * Stored before anything is parsed and before we answer 200. Meta retries only on a non-200,
 * so a parser that throws after we have answered would lose the message otherwise; here the
 * row stays with its error and can be parsed again.
 */
export const whatsappEvents = pgTable(
  'whatsapp_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    payload: jsonb('payload').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    error: text('error'),
  },
  (t) => [index('whatsapp_events_processed_at_idx').on(t.processedAt)],
);
```

Update the file's header comment: it currently promises that conversations arrive in a later
plan. They have arrived.

- [ ] **Step 4: Widen the test helper's truncate**

In `server/test/helpers/db.ts`, extend the statement to:

```ts
  await db.execute(
    sql`truncate table sessions, account_members, whatsapp_events, messages, conversations, contacts, whatsapp_numbers, agents, accounts, users restart identity cascade`,
  );
```

- [ ] **Step 5: Generate the migration**

```bash
npm --prefix server run generate
```

Expected: `server/drizzle/0002_*.sql` creating five tables. Read it before continuing: it must
create, never drop.

- [ ] **Step 6: Run the tests**

```bash
npm --prefix server test
npm --prefix server run typecheck
```

Expected: PASS, seven new cases among them.

- [ ] **Step 7: Apply it to the development database**

```bash
DATABASE_URL=postgres://rakurs:rakurs@localhost:55433/rakurs_dev npm --prefix server run migrate
```

- [ ] **Step 8: Commit**

```bash
git add -A server
git commit -m "Add tables for WhatsApp numbers, contacts, conversations and messages"
```
