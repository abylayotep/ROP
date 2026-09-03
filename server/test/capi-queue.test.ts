import { createHmac, randomUUID } from 'node:crypto';
import { asc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import type { Db } from '../src/db/client.js';
import { agents, capiEvents, capiSettings } from '../src/db/schema.js';
import { CapiError } from '../src/lib/capi/client.js';
import { buildPurchase, serialiseEvent, type CapiEventBody } from '../src/lib/capi/events.js';
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

/** A finished body, exactly as `queuePurchase` would have stored it. */
function body(orderId: string, amount = '15000.00'): CapiEventBody {
  return serialiseEvent(
    buildPurchase({
      orderId,
      ctwaClid: CLID,
      phone: '77085807932',
      amount,
      currency: 'KZT',
      paidAt: new Date('2026-09-01T10:00:00Z'),
    }),
  );
}

/** Queues one pending purchase and returns its row id. */
async function pending(options: { agentId?: string; amount?: string } = {}): Promise<string> {
  const orderId = randomUUID();
  const [row] = await db
    .insert(capiEvents)
    .values({
      agentId: options.agentId ?? agentId,
      kind: 'purchase',
      eventId: `purchase:${orderId}`,
      payload: body(orderId, options.amount),
    })
    .returning({ id: capiEvents.id });
  return row!.id;
}

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
 * it can: by moving the row into the past.
 */
const age = () =>
  db.execute(sql`update capi_events set created_at = now() - interval '1 day'`);

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
    const id = await pending();
    const capi = fakeCapi();

    const result = await sendPendingCapiEvents(db, { capi, key });

    expect(result).toEqual({ sent: 1, failed: 0, skipped: 0 });
    const row = await eventRow(id);
    expect(row.status).toBe('sent');
    expect(row.sentAt).toBeInstanceOf(Date);
    expect(row.error).toBeNull();
    expect(row.attempts).toBe(1);
  });

  it('gives Meta the dataset, the decrypted token and the stored bytes untouched', async () => {
    const id = await pending({ amount: '9007199254740993.99' });
    const capi = fakeCapi();

    await sendPendingCapiEvents(db, { capi, key });

    expect(capi.calls).toHaveLength(1);
    const call = capi.calls[0]!;
    expect(call.datasetId).toBe('1234567890');
    expect(call.token).toBe(TOKEN);
    expect(call.testEventCode).toBeNull();
    // Byte for byte what the column holds: the amount survives only while nothing re-emits it.
    expect(call.events).toEqual([(await eventRow(id)).payload]);
    expect(call.events[0]).toContain('9007199254740993.99');
  });

  it('passes the test event code while an owner is watching the console', async () => {
    await db
      .update(capiSettings)
      .set({ testEventCode: 'TEST12345' })
      .where(eq(capiSettings.agentId, agentId));
    await pending();
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
    const id = await pending();
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
    const id = await pending();
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
    const id = await pending();
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
    const id = await pending();
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
    const id = await pending();
    const capi = fakeCapi(new Error(`socket hang up while sending ${TOKEN}`));

    await sendPendingCapiEvents(db, { capi, key });

    const row = await eventRow(id);
    expect(row.status).toBe('pending');
    expect(row.error).not.toContain(TOKEN);
  });

  it('stops after five attempts and says so', async () => {
    const id = await pending();
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
    await pending();
    const capi = fakeCapi(new CapiError('Meta временно недоступна.', 503, true));

    await sendPendingCapiEvents(db, { capi, key });
    await sendPendingCapiEvents(db, { capi, key });
    await sendPendingCapiEvents(db, { capi, key });

    expect(capi.calls).toHaveLength(1);
  });

  it('retries once the widening gap has passed', async () => {
    await pending();
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
    await pending();
    await pending();
    await pending();
    const capi = fakeCapi({ received: 3, fbtraceId: 'f' });

    const result = await sendPendingCapiEvents(db, { capi, key });

    expect(capi.calls).toHaveLength(1);
    expect(capi.calls[0]!.events).toHaveLength(3);
    expect(result.sent).toBe(3);
    expect((await allEvents()).every((row) => row.status === 'sent')).toBe(true);
  });

  it('keeps two agents in two calls, each with its own token', async () => {
    const second = await otherAgent();
    await pending();
    await pending({ agentId: second });
    const capi = fakeCapi();

    await sendPendingCapiEvents(db, { capi, key });

    expect(capi.calls).toHaveLength(2);
    expect(capi.calls.map((call) => call.token).sort()).toEqual(
      ['EAA-second-token', TOKEN].sort(),
    );
  });

  it('does not let one agent’s refusal cost another agent its report', async () => {
    const second = await otherAgent();
    await pending();
    await pending({ agentId: second });
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
    const id = await pending();
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
    const id = await pending();
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
    const id = await pending();
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
    const id = await pending();
    await pending({ agentId: second });
    const capi = fakeCapi();

    const result = await sendPendingCapiEvents(db, { capi, key });

    expect(result.sent).toBe(1);
    expect(capi.calls).toHaveLength(1);
    const row = await eventRow(id);
    expect(row.status).toBe('pending');
    expect(row.error).not.toBeNull();
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
    const id = await pending();

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
