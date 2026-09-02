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
