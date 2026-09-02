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
import { processPendingEvents } from '../src/lib/whatsapp/inbound.js';
import { withDb } from './helpers/db.js';
import { testEnv } from './helpers/env.js';
import { fakeGraph } from './helpers/fake-graph.js';

const env = testEnv();

let db: Awaited<ReturnType<typeof withDb>>;
let agentId: string;

const deps = () => ({
  graph: fakeGraph(),
  key: Buffer.from(env.CREDENTIALS_KEY, 'base64'),
  mediaDir: env.MEDIA_DIR,
});

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
  await db.insert(whatsappNumbers).values({
    agentId,
    phoneNumberId: '136',
    wabaId: '932',
    displayPhone: '+7 708 580 79 32',
    accessToken: 'encrypted-token',
  });
});

/**
 * One delivery, in the shape Meta actually sends.
 *
 * Everything a test needs to vary is a parameter, so no test has to reach into the
 * structure and cast its way to a field.
 */
const delivery = ({
  phoneNumberId = '136',
  name = 'Айгерім' as string | undefined,
  message = {} as Record<string, unknown>,
  statuses,
}: {
  phoneNumberId?: string;
  name?: string;
  message?: Record<string, unknown>;
  statuses?: { id: string; status: string; timestamp: string; recipient_id: string }[];
} = {}) => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: '932',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '77085807932', phone_number_id: phoneNumberId },
            ...(statuses
              ? { statuses }
              : {
                  contacts: [{ profile: { name }, wa_id: '77771234567' }],
                  messages: [
                    {
                      from: '77771234567',
                      id: 'wamid.ONE',
                      timestamp: '1756000000',
                      type: 'text',
                      text: { body: 'Сәлеметсіз бе! Бағасы қанша?' },
                      ...message,
                    },
                  ],
                }),
          },
        },
      ],
    },
  ],
});

const store = (payload: unknown) => db.insert(whatsappEvents).values({ payload });

describe('inbound processing', () => {
  it('creates the contact, the conversation and the message', async () => {
    await store(delivery());

    expect(await processPendingEvents(db, deps())).toEqual({ processed: 1, failed: 0 });

    const [contact] = await db.select().from(contacts);
    expect(contact).toMatchObject({ agentId, phone: '77771234567', name: 'Айгерім' });

    const [conversation] = await db.select().from(conversations);
    expect(conversation!.lastInboundAt?.toISOString()).toBe('2025-08-24T01:46:40.000Z');
    expect(conversation!.lastMessageAt).toEqual(conversation!.lastInboundAt);

    const [message] = await db.select().from(messages);
    expect(message).toMatchObject({
      waMessageId: 'wamid.ONE',
      direction: 'in',
      author: 'client',
      kind: 'text',
      body: 'Сәлеметсіз бе! Бағасы қанша?',
    });
  });

  it('marks the event processed and leaves no error', async () => {
    await store(delivery());

    await processPendingEvents(db, deps());

    const [event] = await db.select().from(whatsappEvents);
    expect(event!.processedAt).toBeInstanceOf(Date);
    expect(event!.error).toBeNull();
  });

  it('stores one message when Meta delivers the same one twice', async () => {
    await store(delivery());
    await store(delivery());

    await processPendingEvents(db, deps());

    expect(await db.select().from(messages)).toHaveLength(1);
    expect(await db.select().from(conversations)).toHaveLength(1);
  });

  it('keeps a second message in the same conversation', async () => {
    await store(delivery());
    await store(
      delivery({ message: { id: 'wamid.TWO', timestamp: '1756000600', text: { body: 'Алло?' } } }),
    );

    await processPendingEvents(db, deps());

    expect(await db.select().from(messages)).toHaveLength(2);
    expect(await db.select().from(conversations)).toHaveLength(1);
  });

  it('renames a contact who edited their WhatsApp profile', async () => {
    await store(delivery());
    await store(delivery({ name: 'Айгерім Ж.', message: { id: 'wamid.TWO' } }));

    await processPendingEvents(db, deps());

    expect((await db.select().from(contacts))[0]!.name).toBe('Айгерім Ж.');
  });

  it('keeps the name it has when a delivery carries none', async () => {
    await store(delivery());
    await store(delivery({ name: undefined, message: { id: 'wamid.TWO' } }));

    await processPendingEvents(db, deps());

    expect((await db.select().from(contacts))[0]!.name).toBe('Айгерім');
  });

  it('ignores a number that belongs to nobody here', async () => {
    await store(delivery({ phoneNumberId: '999' }));

    expect(await processPendingEvents(db, deps())).toEqual({ processed: 1, failed: 0 });
    expect(await db.select().from(messages)).toEqual([]);
    expect((await db.select().from(whatsappEvents))[0]!.error).toBeNull();
  });

  it('records a type it cannot render rather than dropping the message', async () => {
    await store(
      delivery({
        message: { id: 'wamid.LOC', type: 'location', location: { latitude: 43, longitude: 76 } },
      }),
    );

    await processPendingEvents(db, deps());

    expect((await db.select().from(messages))[0]).toMatchObject({ kind: 'location', body: null });
  });

  it('applies a status callback to the message it names', async () => {
    await store(delivery());
    await processPendingEvents(db, deps());
    await db
      .update(messages)
      .set({ direction: 'out', author: 'operator', status: 'sent' })
      .where(eq(messages.waMessageId, 'wamid.ONE'));

    await store(
      delivery({
        statuses: [
          {
            id: 'wamid.ONE',
            status: 'delivered',
            timestamp: '1756000100',
            recipient_id: '77771234567',
          },
        ],
      }),
    );
    await processPendingEvents(db, deps());

    expect((await db.select().from(messages))[0]!.status).toBe('delivered');
  });

  it('leaves a broken payload with its reason and does not stop the others', async () => {
    await store({ object: 'whatsapp_business_account', entry: 'not an array' });
    await store(delivery());

    expect(await processPendingEvents(db, deps())).toEqual({ processed: 1, failed: 1 });
    expect(await db.select().from(messages)).toHaveLength(1);

    const [broken] = await db
      .select()
      .from(whatsappEvents)
      .where(eq(whatsappEvents.error, 'entry is not an array'));
    expect(broken!.processedAt).toBeNull();
  });

  it('does not touch an event it has already processed', async () => {
    await store(delivery());
    await processPendingEvents(db, deps());

    expect(await processPendingEvents(db, deps())).toEqual({ processed: 0, failed: 0 });
  });
});
