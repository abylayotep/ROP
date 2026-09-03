import { createHmac, randomUUID } from 'node:crypto';
import { asc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import type { Db } from '../src/db/client.js';
import {
  agents,
  capiEvents,
  capiSettings,
  contacts,
  conversations,
  orders,
  whatsappNumbers,
} from '../src/db/schema.js';
import { CapiError } from '../src/lib/capi/client.js';
import {
  buildLead,
  buildPurchase,
  serialiseEvent,
  type CapiEventBody,
} from '../src/lib/capi/events.js';
import { sendPendingCapiEvents } from '../src/lib/capi/queue.js';
import { createAccountWithOwner } from '../src/lib/provision.js';
import { encryptSecret } from '../src/lib/secret-box.js';
import { REDACTED } from '../src/lib/whatsapp/graph.js';
import { withDb } from './helpers/db.js';
import { testEnv } from './helpers/env.js';
import { fakeCapi } from './helpers/fake-capi.js';
import { fakeGraph } from './helpers/fake-graph.js';

const env = testEnv();
const key = Buffer.from(env.CREDENTIALS_KEY, 'base64');
const TOKEN = 'EAA-capi-token-that-must-never-leak';
const CLID = 'ARAaXQ_click_to_whatsapp';

let db: Db;
let agentId: string;

const PAID_AT = new Date('2026-09-01T10:00:00Z');

/** A finished body, exactly as `queuePurchase` would have stored it. */
function body(orderId: string, amount = '15000.00', phone = '77085807932'): CapiEventBody {
  return serialiseEvent(
    buildPurchase({
      orderId,
      ctwaClid: CLID,
      phone,
      amount,
      currency: 'KZT',
      paidAt: PAID_AT,
    }),
  );
}

/** One WhatsApp number per agent, minted once. A conversation cannot exist without one. */
let numbers = new Map<string, string>();
/** Phones are unique per agent, so each fixture takes the next one. */
let nextPhone = 0;
async function numberOf(owner: string): Promise<string> {
  const known = numbers.get(owner);
  if (known !== undefined) return known;
  const [row] = await db
    .insert(whatsappNumbers)
    .values({
      agentId: owner,
      phoneNumberId: `pn-${owner.slice(0, 8)}`,
      wabaId: 'waba',
      displayPhone: '+7 708 580 79 32',
      accessToken: encryptSecret('EAAG-token', key, `pn-${owner.slice(0, 8)}`),
    })
    .returning({ id: whatsappNumbers.id });
  numbers.set(owner, row!.id);
  return row!.id;
}

/**
 * A paid order on an ad-sourced conversation, plus the pending report about it.
 *
 * The rows behind the report are real because the drain now re-reads them: it rebuilds a
 * purchase from its order at claim time, so a fixture whose `order_id` points at nothing is
 * a fixture describing a deleted order, which is a different test.
 */
async function pending(
  options: { agentId?: string; amount?: string; phone?: string } = {},
): Promise<{ id: string; orderId: string; conversationId: string }> {
  const owner = options.agentId ?? agentId;
  const amount = options.amount ?? '15000.00';
  nextPhone += 1;
  const phone = options.phone ?? `7708580${String(nextPhone).padStart(4, '0')}`;

  const [contact] = await db
    .insert(contacts)
    .values({ agentId: owner, phone, name: 'Айгуль' })
    .returning({ id: contacts.id });
  const [conversation] = await db
    .insert(conversations)
    .values({
      agentId: owner,
      contactId: contact!.id,
      whatsappNumberId: await numberOf(owner),
      ctwaClid: CLID,
    })
    .returning({ id: conversations.id });
  const [order] = await db
    .insert(orders)
    .values({
      agentId: owner,
      conversationId: conversation!.id,
      amount,
      currency: 'KZT',
      status: 'paid',
      paidAt: PAID_AT,
    })
    .returning({ id: orders.id });

  const [row] = await db
    .insert(capiEvents)
    .values({
      agentId: owner,
      conversationId: conversation!.id,
      orderId: order!.id,
      kind: 'purchase',
      eventId: `purchase:${order!.id}`,
      payload: body(order!.id, amount, phone),
    })
    .returning({ id: capiEvents.id });

  return { id: row!.id, orderId: order!.id, conversationId: conversation!.id };
}

/** Just the log row id, for the many tests that never touch the order behind it. */
const pendingId = async (options: { agentId?: string; amount?: string } = {}) =>
  (await pending(options)).id;

const eventRow = async (id: string) => {
  const [row] = await db.select().from(capiEvents).where(eq(capiEvents.id, id));
  return row!;
};

const allEvents = () => db.select().from(capiEvents).orderBy(asc(capiEvents.createdAt));

/**
 * Ages every event past its backoff window.
 *
 * The drain refuses to retry an event whose attempt was seconds ago, and that is the point
 * of the backoff — so a test that wants a second attempt has to move the clock the only way
 * it can: by moving the row into the past. `last_attempt_at` is what the gap is measured
 * from; `created_at` moves with it so the row stays coherent.
 */
const age = () =>
  db.execute(sql`
    update capi_events
       set created_at = now() - interval '1 day',
           last_attempt_at = last_attempt_at - interval '1 day'
  `);

/** A second agent with its own account, so one agent's settings cannot answer for the other. */
async function otherAgent(): Promise<string> {
  const { accountId } = await createAccountWithOwner(db, {
    company: 'Вторая',
    email: 'second@example.com',
    name: 'Второй',
    initials: 'ВТ',
    password: 'correct-horse-battery',
  });
  const id = randomUUID();
  await db.insert(agents).values({ id, accountId, name: 'Вторая' });
  await db.insert(capiSettings).values({
    agentId: id,
    datasetId: '999',
    accessToken: encryptSecret('EAA-second-token', key, id),
    enabled: true,
  });
  return id;
}

beforeEach(async () => {
  db = await withDb();
  numbers = new Map();
  nextPhone = 0;
  const { accountId } = await createAccountWithOwner(db, {
    company: 'Сафина',
    email: 'owner@example.com',
    name: 'Владелец',
    initials: 'ВЛ',
    password: 'correct-horse-battery',
  });

  // Minted here rather than read back: the token is sealed against the agent's id, so the
  // row has to carry the sealed value from the start.
  agentId = randomUUID();
  await db.insert(agents).values({ id: agentId, accountId, name: 'Сафина' });
  await db.insert(capiSettings).values({
    agentId,
    datasetId: '1234567890',
    accessToken: encryptSecret(TOKEN, key, agentId),
    enabled: true,
  });
});

describe('sending a pending event', () => {
  it('sends it, marks it sent and clears the error', async () => {
    const id = await pendingId();
    const capi = fakeCapi();

    const result = await sendPendingCapiEvents(db, { capi, key });

    expect(result).toEqual({ sent: 1, failed: 0, skipped: 0 });
    const row = await eventRow(id);
    expect(row.status).toBe('sent');
    expect(row.sentAt).toBeInstanceOf(Date);
    expect(row.error).toBeNull();
    expect(row.attempts).toBe(1);
    // Dated by the claim itself, which is what the backoff measures from.
    expect(row.lastAttemptAt).toBeInstanceOf(Date);
  });

  it('keeps Meta’s trace id, which is what their support asks for', async () => {
    const id = await pendingId();
    const capi = fakeCapi({ received: 1, fbtraceId: 'A7bQ-trace' });

    await sendPendingCapiEvents(db, { capi, key });

    expect((await eventRow(id)).fbtraceId).toBe('A7bQ-trace');
  });

  it('gives Meta the dataset, the decrypted token and the stored bytes untouched', async () => {
    const id = await pendingId({ amount: '999999999999.99' });
    const capi = fakeCapi();

    await sendPendingCapiEvents(db, { capi, key });

    expect(capi.calls).toHaveLength(1);
    const call = capi.calls[0]!;
    expect(call.datasetId).toBe('1234567890');
    expect(call.token).toBe(TOKEN);
    expect(call.testEventCode).toBeNull();
    // Byte for byte what the column holds, at the widest amount `numeric(14,2)` accepts.
    //
    // This test cannot prove the amount never becomes a double: the column tops out at
    // fourteen significant digits, and every such decimal round-trips through one. It proves
    // the drain sends the column's digits. The guarantee itself is guarded where it can be
    // broken — `capi-events.test.ts` and `capi-client.test.ts`, on a figure wider than any
    // order could carry.
    expect(call.events).toEqual([(await eventRow(id)).payload]);
    expect(call.events[0]).toContain('999999999999.99');
  });

  it('passes the test event code while an owner is watching the console', async () => {
    await db
      .update(capiSettings)
      .set({ testEventCode: 'TEST12345' })
      .where(eq(capiSettings.agentId, agentId));
    await pendingId();
    const capi = fakeCapi();

    await sendPendingCapiEvents(db, { capi, key });

    expect(capi.calls[0]!.testEventCode).toBe('TEST12345');
  });

  it('takes nothing when there is nothing pending', async () => {
    const capi = fakeCapi();

    const result = await sendPendingCapiEvents(db, { capi, key });

    expect(result).toEqual({ sent: 0, failed: 0, skipped: 0 });
    expect(capi.calls).toEqual([]);
  });

  it('never sends a skipped row, whose payload is not an event at all', async () => {
    const id = await pendingId();
    await db.update(capiEvents).set({ status: 'skipped', payload: '{}' as CapiEventBody });
    const capi = fakeCapi();

    const result = await sendPendingCapiEvents(db, { capi, key });

    expect(capi.calls).toEqual([]);
    expect(result.sent).toBe(0);
    expect((await eventRow(id)).status).toBe('skipped');
  });
});

describe('what Meta refuses', () => {
  it('keeps a retryable refusal pending and counts the attempt', async () => {
    const id = await pendingId();
    const capi = fakeCapi(new CapiError('Meta временно недоступна.', 503, true, 'try again'));

    const result = await sendPendingCapiEvents(db, { capi, key });

    expect(result).toEqual({ sent: 0, failed: 1, skipped: 0 });
    const row = await eventRow(id);
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(1);
    expect(row.sentAt).toBeNull();
    expect(row.error).toContain('Meta временно недоступна.');
    expect(row.error).toContain('try again');
  });

  it('fails a refusal that will never change its mind, whatever the attempt count', async () => {
    const id = await pendingId();
    const capi = fakeCapi(
      new CapiError('Meta не приняла токен доступа.', 400, false, 'Invalid OAuth token'),
    );

    const result = await sendPendingCapiEvents(db, { capi, key });

    expect(result).toEqual({ sent: 0, failed: 1, skipped: 0 });
    const row = await eventRow(id);
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(1);
    expect(row.error).toContain('Meta не приняла токен доступа.');
  });

  it('keeps the token out of the stored error even when Meta echoes it back', async () => {
    const id = await pendingId();
    const capi = fakeCapi(
      new CapiError(
        'Meta не приняла токен доступа.',
        400,
        false,
        `Malformed access token ${TOKEN}`,
      ),
    );

    await sendPendingCapiEvents(db, { capi, key });

    const row = await eventRow(id);
    expect(row.error).not.toContain(TOKEN);
    expect(row.error).toContain(REDACTED);
  });

  it('keeps the token out of an error that is not a CapiError either', async () => {
    const id = await pendingId();
    const capi = fakeCapi(new Error(`socket hang up while sending ${TOKEN}`));

    await sendPendingCapiEvents(db, { capi, key });

    const row = await eventRow(id);
    expect(row.status).toBe('pending');
    expect(row.error).not.toContain(TOKEN);
  });

  it('stops after five attempts and says so', async () => {
    const id = await pendingId();
    const capi = fakeCapi(new CapiError('Meta временно недоступна.', 503, true, 'down'));

    for (let pass = 0; pass < 6; pass += 1) {
      await age();
      await sendPendingCapiEvents(db, { capi, key });
    }

    expect(capi.calls).toHaveLength(5);
    const row = await eventRow(id);
    expect(row.attempts).toBe(5);
    expect(row.status).toBe('failed');
    expect(row.error).toContain('Meta временно недоступна.');
  });

  it('does not retry an event whose attempt was seconds ago', async () => {
    await pendingId();
    const capi = fakeCapi(new CapiError('Meta временно недоступна.', 503, true));

    await sendPendingCapiEvents(db, { capi, key });
    await sendPendingCapiEvents(db, { capi, key });
    await sendPendingCapiEvents(db, { capi, key });

    expect(capi.calls).toHaveLength(1);
  });

  it('holds the gap after a resend by hand reset the attempts on an old row', async () => {
    // What task 5's resend leaves behind: a row queued days ago, put back to pending with
    // its attempts cleared. Measured from `created_at` the gap would already have elapsed
    // and the whole budget would burn in one second; measured from the attempt it does not.
    const id = await pendingId();
    await db.execute(sql`update capi_events set created_at = now() - interval '3 days'`);
    const capi = fakeCapi(new CapiError('Meta временно недоступна.', 503, true));

    await sendPendingCapiEvents(db, { capi, key });
    await sendPendingCapiEvents(db, { capi, key });
    await sendPendingCapiEvents(db, { capi, key });

    expect(capi.calls).toHaveLength(1);
    expect((await eventRow(id)).attempts).toBe(1);
  });

  it('retries once the widening gap has passed', async () => {
    await pendingId();
    const capi = fakeCapi(new CapiError('Meta временно недоступна.', 503, true), {
      received: 1,
      fbtraceId: 'f',
    });

    await sendPendingCapiEvents(db, { capi, key });
    await age();
    const result = await sendPendingCapiEvents(db, { capi, key });

    expect(capi.calls).toHaveLength(2);
    expect(result.sent).toBe(1);
  });
});

describe('one request per agent', () => {
  it('sends everything pending for one agent in a single call', async () => {
    await pendingId();
    await pendingId();
    await pendingId();
    const capi = fakeCapi({ received: 3, fbtraceId: 'f' });

    const result = await sendPendingCapiEvents(db, { capi, key });

    expect(capi.calls).toHaveLength(1);
    expect(capi.calls[0]!.events).toHaveLength(3);
    expect(result.sent).toBe(3);
    expect((await allEvents()).every((row) => row.status === 'sent')).toBe(true);
  });

  it('keeps two agents in two calls, each with its own token', async () => {
    const second = await otherAgent();
    await pendingId();
    await pendingId({ agentId: second });
    const capi = fakeCapi();

    await sendPendingCapiEvents(db, { capi, key });

    expect(capi.calls).toHaveLength(2);
    expect(capi.calls.map((call) => call.token).sort()).toEqual(
      ['EAA-second-token', TOKEN].sort(),
    );
  });

  it('does not let one agent’s refusal cost another agent its report', async () => {
    const second = await otherAgent();
    await pendingId();
    await pendingId({ agentId: second });
    const capi = fakeCapi(new CapiError('Meta отклонила событие.', 400, false), {
      received: 1,
      fbtraceId: 'f',
    });

    const result = await sendPendingCapiEvents(db, { capi, key });

    expect(result).toEqual({ sent: 1, failed: 1, skipped: 0 });
  });
});

describe('two drains at once', () => {
  it('sends one event once', async () => {
    const id = await pendingId();
    const capi = fakeCapi();

    await Promise.all([
      sendPendingCapiEvents(db, { capi, key }),
      sendPendingCapiEvents(db, { capi, key }),
    ]);

    expect(capi.calls).toHaveLength(1);
    const row = await eventRow(id);
    expect(row.attempts).toBe(1);
    expect(row.status).toBe('sent');
  });
});

describe('settings that changed after queueing', () => {
  it('skips an event whose agent turned the reporting off', async () => {
    const id = await pendingId();
    await db.update(capiSettings).set({ enabled: false }).where(eq(capiSettings.agentId, agentId));
    const capi = fakeCapi();

    const result = await sendPendingCapiEvents(db, { capi, key });

    expect(capi.calls).toEqual([]);
    expect(result).toEqual({ sent: 0, failed: 0, skipped: 1 });
    const row = await eventRow(id);
    expect(row.status).toBe('skipped');
    expect(row.attempts).toBe(0);
    expect(row.error).toContain('отключена');
  });

  it('skips an event whose agent’s settings were deleted', async () => {
    const id = await pendingId();
    await db.delete(capiSettings).where(eq(capiSettings.agentId, agentId));
    const capi = fakeCapi();

    const result = await sendPendingCapiEvents(db, { capi, key });

    expect(capi.calls).toEqual([]);
    expect(result.skipped).toBe(1);
    expect((await eventRow(id)).status).toBe('skipped');
  });

  it('costs one agent its batch when the key no longer opens its token', async () => {
    // Sealed to a different id: the same shape as a rotated key or an edited row.
    await db
      .update(capiSettings)
      .set({ accessToken: encryptSecret(TOKEN, key, randomUUID()) })
      .where(eq(capiSettings.agentId, agentId));
    const second = await otherAgent();
    const id = await pendingId();
    await pendingId({ agentId: second });
    const capi = fakeCapi();

    const result = await sendPendingCapiEvents(db, { capi, key });

    expect(result.sent).toBe(1);
    expect(capi.calls).toHaveLength(1);
    const row = await eventRow(id);
    expect(row.status).toBe('pending');
    expect(row.error).not.toBeNull();
  });
});

describe('the order as it stands at claim time', () => {
  it('does not report a sale that was undone before the drain got to it', async () => {
    // The whole shape of the bug: paid at 10:00, cancelled at 10:01, drained at 10:02. The
    // stored payload still describes a purchase, and nothing in the cabinet could stop it.
    const { id, orderId } = await pending();
    await db.update(orders).set({ status: 'cancelled', paidAt: null }).where(eq(orders.id, orderId));
    const capi = fakeCapi();

    const result = await sendPendingCapiEvents(db, { capi, key });

    expect(capi.calls).toEqual([]);
    expect(result).toEqual({ sent: 0, failed: 0, skipped: 1 });
    const row = await eventRow(id);
    expect(row.status).toBe('skipped');
    expect(row.error).toContain('больше не отмечен оплаченным');
    // Nothing was offered to Meta, so nothing was attempted: the claim's increment is undone.
    expect(row.attempts).toBe(0);
  });

  it('does not report an order that has since been deleted', async () => {
    const { id, orderId } = await pending();
    await db.delete(orders).where(eq(orders.id, orderId));
    const capi = fakeCapi();

    const result = await sendPendingCapiEvents(db, { capi, key });

    expect(capi.calls).toEqual([]);
    expect(result.skipped).toBe(1);
    const row = await eventRow(id);
    expect(row.status).toBe('skipped');
    expect(row.error).toContain('заказ удалён');
  });

  it('sends the amount as it stands now, under the same event id', async () => {
    // The other half: a zero was missing, the operator fixed the order, and the stored
    // payload still holds the old digits. `alreadyQueued` will never queue a corrected one.
    const { id, orderId } = await pending({ amount: '1500.00' });
    const before = await eventRow(id);
    await db.update(orders).set({ amount: '15000.00' }).where(eq(orders.id, orderId));
    const capi = fakeCapi();

    const result = await sendPendingCapiEvents(db, { capi, key });

    expect(result.sent).toBe(1);
    expect(capi.calls[0]!.events[0]).toContain('15000.00');
    expect(capi.calls[0]!.events[0]).not.toContain('1500.00"');
    const row = await eventRow(id);
    // Stored, so the log shows the bytes that went rather than the ones that did not.
    expect(row.payload).toBe(capi.calls[0]!.events[0]);
    expect(row.payload).not.toBe(before.payload);
    // The one thing that must not move: Meta counts one conversion per event id.
    expect(row.eventId).toBe(before.eventId);
    expect(row.payload).toContain(before.eventId);
  });

  it('sends the paid time as it stands now, not as it was queued', async () => {
    const { id, orderId } = await pending();
    const later = new Date('2026-09-02T08:30:00Z');
    await db.update(orders).set({ paidAt: later }).where(eq(orders.id, orderId));
    const capi = fakeCapi();

    await sendPendingCapiEvents(db, { capi, key });

    expect(capi.calls[0]!.events[0]).toContain(String(Math.floor(later.getTime() / 1000)));
    expect((await eventRow(id)).status).toBe('sent');
  });

  it('sends an unchanged order without rewriting its stored payload', async () => {
    const { id } = await pending();
    const before = await eventRow(id);
    const capi = fakeCapi();

    await sendPendingCapiEvents(db, { capi, key });

    const row = await eventRow(id);
    expect(row.payload).toBe(before.payload);
    expect(capi.calls[0]!.events).toEqual([before.payload]);
  });

  it('sends a lead as it was stored, because a lead cannot be undone', async () => {
    // A conversation that qualified and then walked on to `success` is still a lead that
    // happened. Re-reading its stage would drop exactly the leads that converted, and
    // `stage_set_at` would by then name the later stage — so a lead is sent as it was built.
    const { conversationId } = await pending();
    const [lead] = await db
      .insert(capiEvents)
      .values({
        agentId,
        conversationId,
        kind: 'lead',
        eventId: `lead:${conversationId}`,
        payload: serialiseEvent(
          buildLead({
            conversationId,
            ctwaClid: CLID,
            phone: '77085807932',
            occurredAt: PAID_AT,
          }),
        ),
      })
      .returning({ id: capiEvents.id, payload: capiEvents.payload });
    const capi = fakeCapi({ received: 2, fbtraceId: 'f' });

    const result = await sendPendingCapiEvents(db, { capi, key });

    expect(result.sent).toBe(2);
    expect(capi.calls[0]!.events).toContain(lead!.payload);
    expect((await eventRow(lead!.id)).payload).toBe(lead!.payload);
  });
});

describe('an event nobody ever answered for', () => {
  /**
   * What a drain killed between the claim and the outcome leaves behind: pending, with the
   * attempt already spent. Five of these and the row is outside every ready clause forever.
   */
  const stranded = async (id: string) =>
    db
      .update(capiEvents)
      .set({
        status: 'pending',
        attempts: 5,
        error: null,
        // Long enough ago that no send could still be waiting on Meta. A row claimed a
        // moment ago looks the same and must be left alone; the test below pins that.
        lastAttemptAt: new Date(Date.now() - 60 * 60 * 1000),
      })
      .where(eq(capiEvents.id, id));

  it('fails a pending row whose attempts are all spent, so it stops being invisible', async () => {
    const id = await pendingId();
    await stranded(id);
    const capi = fakeCapi();

    const result = await sendPendingCapiEvents(db, { capi, key });

    // Never sent, and never claimable again — but now it says so.
    expect(capi.calls).toEqual([]);
    expect(result.failed).toBe(1);
    const row = await eventRow(id);
    expect(row.status).toBe('failed');
    expect(row.error).toContain('Попытки отправки закончились');
    // `failed` is the state the screen paints red and offers «Отправить снова» on.
    expect(row.status).not.toBe('pending');
  });

  it('leaves the reason Meta gave, where there was one', async () => {
    const id = await pendingId();
    await stranded(id);
    await db
      .update(capiEvents)
      .set({ error: 'Meta временно недоступна.' })
      .where(eq(capiEvents.id, id));
    const capi = fakeCapi();

    await sendPendingCapiEvents(db, { capi, key });

    const row = await eventRow(id);
    expect(row.status).toBe('failed');
    expect(row.error).toBe('Meta временно недоступна.');
  });

  it('leaves a send that is merely still happening alone', async () => {
    // The overlap this guard exists for: the timer's drain holds a `draining` lock, but the
    // one behind a webhook does not, and a row that was claimed a second ago is pending, at
    // the cap and without an outcome — indistinguishable from a stranded one but for its age.
    const id = await pendingId();
    await db
      .update(capiEvents)
      .set({ status: 'pending', attempts: 5, error: null, lastAttemptAt: new Date() })
      .where(eq(capiEvents.id, id));
    const capi = fakeCapi();

    const result = await sendPendingCapiEvents(db, { capi, key });

    // Still in flight as far as this pass knows, so it says nothing about it at all.
    expect(result.failed).toBe(0);
    const row = await eventRow(id);
    expect(row.status).toBe('pending');
    expect(row.error).toBeNull();
  });

  it('leaves a pending row that still has attempts alone', async () => {
    const id = await pendingId();
    await db.update(capiEvents).set({ attempts: 4, lastAttemptAt: new Date() });
    const capi = fakeCapi();

    await sendPendingCapiEvents(db, { capi, key });

    expect((await eventRow(id)).status).toBe('pending');
  });
});

describe('the drain on the webhook', () => {
  let app: FastifyInstance;

  const sign = (raw: string) =>
    `sha256=${createHmac('sha256', env.META_APP_SECRET).update(raw).digest('hex')}`;

  /** Waits for the work that runs after Meta has had its 200. */
  async function eventually(check: () => Promise<boolean>): Promise<void> {
    for (let tries = 0; tries < 100; tries += 1) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('the drain never ran');
  }

  it('runs behind the response, not in front of it', async () => {
    const capi = fakeCapi();
    app = buildServer(env, db, { capi, graph: fakeGraph() });
    await app.ready();
    const id = await pendingId();

    const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
    const res = await app.inject({
      method: 'POST',
      url: '/api/whatsapp/webhook',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(raw) },
      payload: raw,
    });

    // Meta is answered before any of this happens; the send is on its way afterwards.
    expect(res.statusCode).toBe(200);
    await eventually(async () => (await eventRow(id)).status === 'sent');
    expect(capi.calls).toHaveLength(1);
  });
});
