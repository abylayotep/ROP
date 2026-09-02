# Task 6: Click-to-WhatsApp attribution

Part of [WhatsApp Cloud API](2026-09-02-whatsapp-cloud-api.md).

The reason stage 6 can exist. A conversation that began with a click on a Facebook or Instagram
ad carries a `referral` block on its **first message only**, and inside it a `ctwa_clid` — the
click identifier Meta matches a purchase against. Miss it and there is nothing to send back:
it cannot be derived, looked up, or asked for later.

It gets its own task rather than a line inside task 5 because it is the one part of this stage
whose absence would be invisible until stage 6 failed.

**Files:**
- Modify: `server/src/lib/whatsapp/inbound.ts`
- Test: `server/test/whatsapp-attribution.test.ts`

**Interfaces:**
- Consumes: `processPendingEvents` and the conversation upsert from task 5.
- Produces: no new export. The conversation's `ctwaClid`, `adSourceId`, `adSourceType`,
  `adHeadline`, `adBody` and `referralSeenAt` are filled.

---

- [ ] **Step 1: Write the failing test**

Create `server/test/whatsapp-attribution.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { agents, conversations, whatsappEvents, whatsappNumbers } from '../src/db/schema.js';
import { createAccountWithOwner } from '../src/lib/provision.js';
import { processPendingEvents } from '../src/lib/whatsapp/inbound.js';
import { withDb } from './helpers/db.js';
import { testEnv } from './helpers/env.js';
import { fakeGraph } from './helpers/fake-graph.js';

const env = testEnv();

let db: Awaited<ReturnType<typeof withDb>>;

const deps = () => ({
  graph: fakeGraph(),
  key: Buffer.from(env.CREDENTIALS_KEY, 'base64'),
  mediaDir: env.MEDIA_DIR,
});

/** What Meta puts on the first message of a conversation that started from an ad. */
const REFERRAL = {
  source_url: 'https://fb.me/2abcdef',
  source_id: '120210000000000001',
  source_type: 'ad',
  headline: 'Картина-светильник 2 в 1',
  body: 'Ручная работа, доставка по Казахстану',
  media_type: 'image',
  ctwa_clid: 'ARAaZmFrZS1jbGljay1pZA',
};

const delivery = (message: Record<string, unknown>) => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: '932',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '77085807932', phone_number_id: '136' },
            contacts: [{ profile: { name: 'Айгерім' }, wa_id: '77771234567' }],
            messages: [
              {
                from: '77771234567',
                id: 'wamid.ONE',
                timestamp: '1756000000',
                type: 'text',
                text: { body: 'Здравствуйте! Интересует' },
                ...message,
              },
            ],
          },
        },
      ],
    },
  ],
});

const store = (payload: unknown) => db.insert(whatsappEvents).values({ payload });
const onlyConversation = async () => (await db.select().from(conversations))[0]!;

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
  await db.insert(whatsappNumbers).values({
    agentId: agent!.id,
    phoneNumberId: '136',
    wabaId: '932',
    displayPhone: '+7 708 580 79 32',
    accessToken: 'encrypted-token',
  });
});

describe('click-to-whatsapp attribution', () => {
  it('records the ad a conversation came from', async () => {
    await store(delivery({ referral: REFERRAL }));

    await processPendingEvents(db, deps());

    expect(await onlyConversation()).toMatchObject({
      ctwaClid: 'ARAaZmFrZS1jbGljay1pZA',
      adSourceId: '120210000000000001',
      adSourceType: 'ad',
      adHeadline: 'Картина-светильник 2 в 1',
      adBody: 'Ручная работа, доставка по Казахстану',
    });
    expect((await onlyConversation()).referralSeenAt).toBeInstanceOf(Date);
  });

  it('leaves a conversation that came from nowhere honestly empty', async () => {
    await store(delivery({}));

    await processPendingEvents(db, deps());

    const conversation = await onlyConversation();
    expect(conversation.ctwaClid).toBeNull();
    expect(conversation.adSourceId).toBeNull();
    expect(conversation.referralSeenAt).toBeNull();
  });

  it('keeps the first ad when a later message carries another', async () => {
    await store(delivery({ referral: REFERRAL }));
    await store(
      delivery({
        id: 'wamid.TWO',
        timestamp: '1756000600',
        referral: { ...REFERRAL, source_id: '999', ctwa_clid: 'ARAasecond' },
      }),
    );

    await processPendingEvents(db, deps());

    expect(await onlyConversation()).toMatchObject({
      ctwaClid: 'ARAaZmFrZS1jbGljay1pZA',
      adSourceId: '120210000000000001',
    });
  });

  it('fills an empty conversation from a later referral', async () => {
    await store(delivery({}));
    await store(delivery({ id: 'wamid.TWO', timestamp: '1756000600', referral: REFERRAL }));

    await processPendingEvents(db, deps());

    expect((await onlyConversation()).ctwaClid).toBe('ARAaZmFrZS1jbGljay1pZA');
  });

  it('records an ad even when the referral has no click id', async () => {
    const { ctwa_clid: _dropped, ...withoutClid } = REFERRAL;
    await store(delivery({ referral: withoutClid }));

    await processPendingEvents(db, deps());

    const conversation = await onlyConversation();
    expect(conversation.adSourceId).toBe('120210000000000001');
    expect(conversation.ctwaClid).toBeNull();
    expect(conversation.referralSeenAt).toBeInstanceOf(Date);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm --prefix server test -- whatsapp-attribution
```

Expected: FAIL — `ctwaClid` is null, because nothing reads `referral` yet.

- [ ] **Step 3: Read the referral**

In `server/src/lib/whatsapp/inbound.ts`, add the shape to the message interface:

```ts
interface Referral {
  source_id?: string;
  source_type?: string;
  headline?: string;
  body?: string;
  ctwa_clid?: string;
}
```

and `referral?: Referral;` to `InboundMessage`.

Add the function that writes it:

```ts
/**
 * Records the ad a conversation came from, once.
 *
 * Meta puts `referral` on the first message of a click-to-WhatsApp conversation and never
 * again, and `ctwa_clid` inside it is what stage 6 matches a purchase against — there is no
 * way to look it up afterwards. The `referral_seen_at is null` condition is what makes this
 * write-once: a later ad must not overwrite the one that actually paid for this client.
 *
 * A referral without a click id is still worth keeping: it names the ad for a human reading
 * the conversation, even though Meta cannot attribute a purchase to it.
 */
async function recordReferral(
  db: Db,
  conversationId: string,
  referral: Referral,
): Promise<void> {
  await db
    .update(conversations)
    .set({
      ctwaClid: referral.ctwa_clid ?? null,
      adSourceId: referral.source_id ?? null,
      adSourceType: referral.source_type ?? null,
      adHeadline: referral.headline ?? null,
      adBody: referral.body ?? null,
      referralSeenAt: new Date(),
    })
    .where(and(eq(conversations.id, conversationId), isNull(conversations.referralSeenAt)));
}
```

Call it from the message loop in `applyChange`, before the timestamps are updated:

```ts
    if (incoming.referral) await recordReferral(db, conversationId, incoming.referral);
```

`and` and `isNull` are already imported by the module; if the compiler says otherwise, add them.

- [ ] **Step 4: Run it and watch it pass**

```bash
npm --prefix server test -- whatsapp-attribution
```

Expected: PASS, five cases.

- [ ] **Step 5: Run everything**

```bash
npm --prefix server test
npm --prefix server run typecheck
```

Expected: PASS. Task 5's cases still pass: a conversation with no referral is untouched.

- [ ] **Step 6: Commit**

```bash
git add -A server
git commit -m "Record the ad a WhatsApp conversation came from, once"
```
