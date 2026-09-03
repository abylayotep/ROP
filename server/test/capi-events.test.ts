import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { accounts, agents, capiEvents } from '../src/db/schema.js';
import {
  buildLead,
  buildPurchase,
  hashPhone,
  leadEventId,
  purchaseEventId,
  serialiseEvent,
} from '../src/lib/capi/events.js';
import { withDb } from './helpers/db.js';

/** SHA-256 of `77085807932`, computed once by hand so the test does not restate the code. */
const PHONE_DIGEST = '14cfce5f8009bcb4cfb294f485267f81559e5a921b807ee82e0054ac268c15e0';

const ORDER_ID = '4c8f2f6e-1f1e-4a5a-9c3b-8f2a1d4e6b70';
const CONVERSATION_ID = 'a1d3b9c4-2e77-4f0b-8b1a-5d6c7e8f9a0b';

/** A week before the test runs, to the second. */
const paidAt = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

const purchase = () =>
  buildPurchase({
    orderId: ORDER_ID,
    ctwaClid: 'ARAaXQ_ctwa_clid',
    phone: '+7 708 580 79 32',
    amount: '1234567.89',
    currency: 'KZT',
    paidAt,
  });

const lead = () =>
  buildLead({
    conversationId: CONVERSATION_ID,
    ctwaClid: 'ARAaXQ_ctwa_clid',
    phone: '+7 708 580 79 32',
    occurredAt: paidAt,
  });

describe('hashPhone', () => {
  it('is lowercase SHA-256 hex of the digits', () => {
    expect(hashPhone('77085807932')).toBe(PHONE_DIGEST);
    expect(hashPhone('77085807932')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('normalises before hashing, so a written number and a stored one agree', () => {
    expect(hashPhone('+7 708 580 79 32')).toBe(PHONE_DIGEST);
    expect(hashPhone(' +7-708-580-79-32 ')).toBe(PHONE_DIGEST);
  });
});

describe('event ids', () => {
  it('is stable for one order and different for another', () => {
    expect(purchaseEventId(ORDER_ID)).toBe(purchaseEventId(ORDER_ID));
    expect(purchaseEventId(ORDER_ID)).not.toBe(purchaseEventId(CONVERSATION_ID));
  });

  it('is stable for one conversation and different for another', () => {
    expect(leadEventId(CONVERSATION_ID)).toBe(leadEventId(CONVERSATION_ID));
    expect(leadEventId(CONVERSATION_ID)).not.toBe(leadEventId(ORDER_ID));
  });

  it('never collides between a purchase and a lead, even on the same id', () => {
    expect(purchaseEventId(ORDER_ID)).not.toBe(leadEventId(ORDER_ID));
  });

  it('puts the id it was built from on the event', () => {
    expect(purchase().event_id).toBe(purchaseEventId(ORDER_ID));
    expect(lead().event_id).toBe(leadEventId(CONVERSATION_ID));
  });
});

describe('buildPurchase', () => {
  it('carries the name, the channel, the click and the hashed phone', () => {
    const event = purchase();

    expect(event.event_name).toBe('Purchase');
    expect(event.action_source).toBe('business_messaging');
    expect(event.messaging_channel).toBe('whatsapp');
    expect(event.user_data.ctwa_clid).toBe('ARAaXQ_ctwa_clid');
    expect(event.user_data.ph).toEqual([PHONE_DIGEST]);
  });

  it('carries the order currency', () => {
    expect(purchase().custom_data.currency).toBe('KZT');
  });

  it('reports the second the order was paid, not the moment of building', () => {
    const event = purchase();

    expect(event.event_time).toBe(Math.floor(paidAt.getTime() / 1000));
    expect(event.event_time).toBeLessThan(Math.floor(Date.now() / 1000) - 6 * 24 * 60 * 60);
  });

  it('serialises the amount as the exact decimal from the column', () => {
    const body = serialiseEvent(purchase());

    expect(body).toContain('"value":1234567.89');
    expect(body).not.toContain('"value":"1234567.89"');
  });

  it('keeps every digit of an amount at the column width', () => {
    const event = buildPurchase({
      orderId: ORDER_ID,
      ctwaClid: 'clid',
      phone: '77085807932',
      amount: '999999999999.99',
      currency: 'KZT',
      paidAt,
    });

    expect(serialiseEvent(event)).toContain('"value":999999999999.99');
  });

  it('refuses an amount that is not a plain decimal', () => {
    expect(() =>
      buildPurchase({
        orderId: ORDER_ID,
        ctwaClid: 'clid',
        phone: '77085807932',
        amount: '1e6',
        currency: 'KZT',
        paidAt,
      }),
    ).toThrow(/amount/i);
  });

  it('sends nothing about the customer beyond the click and the hashed phone', () => {
    const body = serialiseEvent(purchase());

    expect(body).not.toContain('77085807932');
    expect(body).not.toContain('+7 708');
    expect(JSON.parse(body)).toEqual({
      event_name: 'Purchase',
      event_time: Math.floor(paidAt.getTime() / 1000),
      event_id: purchaseEventId(ORDER_ID),
      action_source: 'business_messaging',
      messaging_channel: 'whatsapp',
      user_data: { ctwa_clid: 'ARAaXQ_ctwa_clid', ph: [PHONE_DIGEST] },
      custom_data: { value: 1234567.89, currency: 'KZT' },
    });
  });
});

describe('buildLead', () => {
  it('carries the name but no money', () => {
    const event = lead();

    expect(event.event_name).toBe('Lead');
    expect(event).not.toHaveProperty('custom_data');

    const body = serialiseEvent(event);
    expect(body).not.toContain('value');
    expect(body).not.toContain('currency');
  });

  it('sends nothing about the customer beyond the click and the hashed phone', () => {
    const body = serialiseEvent(lead());

    expect(body).not.toContain('77085807932');
    expect(JSON.parse(body)).toEqual({
      event_name: 'Lead',
      event_time: Math.floor(paidAt.getTime() / 1000),
      event_id: leadEventId(CONVERSATION_ID),
      action_source: 'business_messaging',
      messaging_channel: 'whatsapp',
      user_data: { ctwa_clid: 'ARAaXQ_ctwa_clid', ph: [PHONE_DIGEST] },
    });
  });
});

/**
 * The point of the text column, pinned end to end.
 *
 * The builder being exact is worth nothing if the store is not: the amount stays the amount
 * only while nothing parses and re-emits it, so this writes a real row and reads the real
 * bytes back rather than trusting that `jsonb` would have been fine.
 */
describe('a stored event is byte for byte what is sent', () => {
  async function store(amount: string): Promise<string> {
    const db = await withDb();
    const [account] = await db.insert(accounts).values({ name: 'Сафина' }).returning();
    const [agent] = await db
      .insert(agents)
      .values({ accountId: account!.id, name: 'Сафина' })
      .returning();

    const event = buildPurchase({
      orderId: ORDER_ID,
      ctwaClid: 'clid',
      phone: '77085807932',
      amount,
      currency: 'KZT',
      paidAt,
    });
    const body = serialiseEvent(event);

    await db.insert(capiEvents).values({
      agentId: agent!.id,
      kind: 'purchase',
      eventId: event.event_id,
      payload: body,
    });

    const [row] = await db
      .select({ payload: capiEvents.payload })
      .from(capiEvents)
      .where(eq(capiEvents.eventId, event.event_id));

    // What went in is what came out, with no parse in between.
    expect(row!.payload).toBe(body);

    return row!.payload;
  }

  /**
   * The number as it literally appears in the stored body. Matched rather than parsed:
   * `JSON.parse` here would make a double and hide the very thing being asserted.
   */
  const valueLiteral = (stored: string): string | undefined =>
    /"value":([^,}]+)/.exec(stored)?.[1];

  it('keeps an amount with cents exactly', async () => {
    const stored = await store('1234567.89');

    expect(stored).toContain('"value":1234567.89');
    expect(valueLiteral(stored)).toBe('1234567.89');
    expect(stored).not.toContain('1234567.890000001');
  });

  it('keeps an amount at the full column width exactly', async () => {
    const stored = await store('999999999999.99');

    expect(stored).toContain('"value":999999999999.99');
    expect(valueLiteral(stored)).toBe('999999999999.99');
  });
});
