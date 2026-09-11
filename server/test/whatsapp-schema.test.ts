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
