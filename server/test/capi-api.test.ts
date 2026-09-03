import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
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
  UNREPORTABLE_BODY,
  buildPurchase,
  serialiseEvent,
  type CapiEventBody,
} from '../src/lib/capi/events.js';
import { tokenAad } from '../src/lib/capi/queue.js';
import { addMember, createAccountWithOwner } from '../src/lib/provision.js';
import { decryptSecret, encryptSecret } from '../src/lib/secret-box.js';
import { REDACTED } from '../src/lib/whatsapp/graph.js';
import { withDb } from './helpers/db.js';
import { testEnv } from './helpers/env.js';
import { fakeCapi, type FakeCapi } from './helpers/fake-capi.js';
import { fakeGraph } from './helpers/fake-graph.js';

const env = testEnv();
const key = Buffer.from(env.CREDENTIALS_KEY, 'base64');
const PASSWORD = 'correct-horse-battery';
const TOKEN = 'EAA-capi-token-that-must-never-leak';
const CLID = 'ARAaXQ_click_to_whatsapp';

let app: FastifyInstance;
let db: Db;
let capi: FakeCapi;
let accountId: string;
let agentId: string;
let conversationId: string;
let owner: Record<string, string>;
let member: Record<string, string>;

async function login(email: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: PASSWORD },
  });
  const cookie = res.cookies[0]!;
  return { [cookie.name]: cookie.value };
}

const settingsUrl = (id = agentId) => `/api/agents/${id}/capi`;
const eventsUrl = (id = agentId) => `/api/agents/${id}/capi/events`;
const resendUrl = (eventRowId: string, id = agentId) =>
  `/api/agents/${id}/capi/events/${eventRowId}/resend`;

/** A finished body, exactly as `queuePurchase` would have stored it. */
const body = (orderId: string, amount = '15000.00'): CapiEventBody =>
  serialiseEvent(
    buildPurchase({
      orderId,
      ctwaClid: CLID,
      phone: '77085807932',
      amount,
      currency: 'KZT',
      paidAt: new Date('2026-09-01T10:00:00Z'),
    }),
  );

/** A paid order on the conversation, so an event has an amount to be read back with. */
async function paidOrder(amount = '15000.00'): Promise<string> {
  const [row] = await db
    .insert(orders)
    .values({
      agentId,
      conversationId,
      amount,
      currency: 'KZT',
      status: 'paid',
      paidAt: new Date('2026-09-01T10:00:00Z'),
    })
    .returning({ id: orders.id });
  return row!.id;
}

/** One row in the log, in whatever state the caller asks for. */
async function event(
  overrides: Partial<typeof capiEvents.$inferInsert> = {},
): Promise<typeof capiEvents.$inferSelect> {
  const orderId = await paidOrder();
  const [row] = await db
    .insert(capiEvents)
    .values({
      agentId,
      conversationId,
      orderId,
      kind: 'purchase',
      eventId: `purchase:${orderId}`,
      payload: body(orderId),
      ...overrides,
    })
    .returning();
  return row!;
}

/** What the drain wrote onto a row that has already failed five times. */
const failed = () =>
  event({
    status: 'failed',
    attempts: 5,
    lastAttemptAt: new Date('2026-09-02T10:00:00Z'),
    error: 'Meta не приняла токен доступа. Ответ Meta: Invalid OAuth access token.',
  });

/** A conversation that never came from an ad: nothing could be built, so nothing was stored. */
const unreportable = async () => {
  const orderId = await paidOrder();
  const [row] = await db
    .insert(capiEvents)
    .values({
      agentId,
      conversationId,
      orderId,
      kind: 'purchase',
      eventId: `purchase:${orderId}`,
      payload: UNREPORTABLE_BODY,
      status: 'skipped',
      error: 'Не отправлено: диалог начался не с рекламы, у него нет ctwa_clid.',
    })
    .returning();
  return row!;
};

const rowOf = async (id: string) => {
  const [row] = await db.select().from(capiEvents).where(eq(capiEvents.id, id));
  return row!;
};

const storedSettings = async (id = agentId) => {
  const [row] = await db.select().from(capiSettings).where(eq(capiSettings.agentId, id));
  return row;
};

/** A second agent, in a second account, so nothing of the first can answer for it. */
async function otherAgent(): Promise<string> {
  const { accountId: other } = await createAccountWithOwner(db, {
    company: 'Вторая',
    email: 'second@example.com',
    name: 'Второй',
    initials: 'ВТ',
    password: PASSWORD,
  });
  const id = randomUUID();
  await db.insert(agents).values({ id, accountId: other, name: 'Вторая' });
  return id;
}

beforeEach(async () => {
  db = await withDb();
  ({ accountId } = await createAccountWithOwner(db, {
    company: 'Сафина',
    email: 'owner@example.com',
    name: 'Владелец',
    initials: 'ВЛ',
    password: PASSWORD,
  }));
  await addMember(db, {
    company: 'Сафина',
    email: 'member@example.com',
    name: 'Оператор',
    initials: 'ОП',
    password: PASSWORD,
    role: 'member',
  });

  capi = fakeCapi();
  app = buildServer(env, db, { graph: fakeGraph(), capi });
  await app.ready();
  owner = await login('owner@example.com');
  member = await login('member@example.com');

  const created = await app.inject({
    method: 'POST',
    url: `/api/accounts/${accountId}/agents`,
    cookies: owner,
    payload: { name: 'Сафина' },
  });
  agentId = created.json().id;

  const [number] = await db
    .insert(whatsappNumbers)
    .values({
      agentId,
      phoneNumberId: '136',
      wabaId: 'waba',
      displayPhone: '+7 708 580 79 32',
      accessToken: 'x',
    })
    .returning();
  const [contact] = await db
    .insert(contacts)
    .values({ agentId, phone: '77085807932', name: 'Айгуль' })
    .returning();
  const [conversation] = await db
    .insert(conversations)
    .values({
      agentId,
      contactId: contact!.id,
      whatsappNumberId: number!.id,
      ctwaClid: CLID,
    })
    .returning();
  conversationId = conversation!.id;
});

describe('reading the settings', () => {
  it('answers a blank card for an agent that has never configured this', async () => {
    const res = await app.inject({ method: 'GET', url: settingsUrl(), cookies: owner });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      datasetId: '',
      testEventCode: null,
      enabled: false,
      tokenSet: false,
      verifiedAt: null,
      error: null,
    });
  });

  it('never returns the token, only that one is stored', async () => {
    await db.insert(capiSettings).values({
      agentId,
      datasetId: '1234567890',
      accessToken: encryptSecret(TOKEN, key, tokenAad(agentId)),
      enabled: true,
    });

    const res = await app.inject({ method: 'GET', url: settingsUrl(), cookies: owner });

    expect(res.json().tokenSet).toBe(true);
    expect(res.payload).not.toContain(TOKEN);
    expect(Object.keys(res.json())).not.toContain('accessToken');
  });

  it('is open to a member', async () => {
    const res = await app.inject({ method: 'GET', url: settingsUrl(), cookies: member });
    expect(res.statusCode).toBe(200);
  });

  it('answers 404 for an agent the caller does not belong to', async () => {
    const stranger = await otherAgent();
    const res = await app.inject({ method: 'GET', url: settingsUrl(stranger), cookies: owner });
    expect(res.statusCode).toBe(404);
  });
});

describe('saving the settings', () => {
  it('verifies the pair against Meta before storing it', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: settingsUrl(),
      cookies: owner,
      payload: { datasetId: '1234567890', accessToken: TOKEN, testEventCode: 'TEST12345' },
    });

    expect(res.statusCode).toBe(200);
    // Verified first, stored second: the call happened, and it carried what was typed.
    expect(capi.calls).toHaveLength(1);
    expect(capi.calls[0]!.datasetId).toBe('1234567890');
    expect(capi.calls[0]!.token).toBe(TOKEN);
    // Marked as a test, so proving the wiring never teaches the optimiser about a sale
    // that did not happen.
    expect(capi.calls[0]!.testEventCode).toBe('TEST12345');
    expect(capi.calls[0]!.events).toHaveLength(1);

    const settings = await storedSettings();
    expect(settings!.datasetId).toBe('1234567890');
    expect(settings!.verifiedAt).toBeInstanceOf(Date);
    expect(settings!.error).toBeNull();
  });

  it('marks the verification event as a test even when the owner gave no code', async () => {
    await app.inject({
      method: 'PUT',
      url: settingsUrl(),
      cookies: owner,
      payload: { datasetId: '1234567890', accessToken: TOKEN },
    });

    expect(capi.calls[0]!.testEventCode).not.toBeNull();
    expect((await storedSettings())!.testEventCode).toBeNull();
  });

  it('stores the token encrypted and sealed to the agent', async () => {
    await app.inject({
      method: 'PUT',
      url: settingsUrl(),
      cookies: owner,
      payload: { datasetId: '1234567890', accessToken: TOKEN },
    });

    const stored = (await storedSettings())!.accessToken;
    expect(stored).not.toContain(TOKEN);
    expect(decryptSecret(stored, key, tokenAad(agentId))).toBe(TOKEN);
    // Sealed to this agent: the same bytes on another agent's row open into nothing.
    expect(() => decryptSecret(stored, key, tokenAad(randomUUID()))).toThrow();
  });

  it('never returns the token it was just given', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: settingsUrl(),
      cookies: owner,
      payload: { datasetId: '1234567890', accessToken: TOKEN },
    });

    expect(res.payload).not.toContain(TOKEN);
    expect(res.json().tokenSet).toBe(true);
    expect(res.json().verifiedAt).not.toBeNull();
  });

  it('answers 502 with Meta’s own reason and stores nothing when Meta refuses', async () => {
    capi = fakeCapi(
      new CapiError('Meta не приняла токен доступа.', 400, false, 'Invalid OAuth access token.'),
    );
    app = buildServer(env, db, { graph: fakeGraph(), capi });
    await app.ready();

    const res = await app.inject({
      method: 'PUT',
      url: settingsUrl(),
      cookies: owner,
      payload: { datasetId: '1234567890', accessToken: TOKEN },
    });

    expect(res.statusCode).toBe(502);
    expect(res.json().message).toContain('Meta не приняла токен доступа.');
    expect(res.json().message).toContain('Invalid OAuth access token.');
    expect(await storedSettings()).toBeUndefined();
  });

  it('redacts the token out of Meta’s refusal', async () => {
    capi = fakeCapi(
      new CapiError('Meta отклонила событие.', 400, false, `Malformed access token ${TOKEN}`),
    );
    app = buildServer(env, db, { graph: fakeGraph(), capi });
    await app.ready();

    const res = await app.inject({
      method: 'PUT',
      url: settingsUrl(),
      cookies: owner,
      payload: { datasetId: '1234567890', accessToken: TOKEN },
    });

    expect(res.payload).not.toContain(TOKEN);
    expect(res.json().message).toContain(REDACTED);
  });

  it('leaves a working pair in place when a replacement is refused', async () => {
    await app.inject({
      method: 'PUT',
      url: settingsUrl(),
      cookies: owner,
      payload: { datasetId: '1234567890', accessToken: TOKEN },
    });

    capi = fakeCapi(new CapiError('Meta не нашла такой набор данных.', 404, false));
    app = buildServer(env, db, { graph: fakeGraph(), capi });
    await app.ready();
    const res = await app.inject({
      method: 'PUT',
      url: settingsUrl(),
      cookies: owner,
      payload: { datasetId: 'typo', accessToken: 'EAA-другой' },
    });

    expect(res.statusCode).toBe(502);
    const settings = await storedSettings();
    expect(settings!.datasetId).toBe('1234567890');
    expect(decryptSecret(settings!.accessToken, key, tokenAad(agentId))).toBe(TOKEN);
  });

  it('keeps the stored token when a later save does not repeat it', async () => {
    await app.inject({
      method: 'PUT',
      url: settingsUrl(),
      cookies: owner,
      payload: { datasetId: '1234567890', accessToken: TOKEN, enabled: true },
    });

    const res = await app.inject({
      method: 'PUT',
      url: settingsUrl(),
      cookies: owner,
      payload: { datasetId: '1234567890', testEventCode: 'TEST12345' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().testEventCode).toBe('TEST12345');
    // Verified again with the token that is stored, so a save cannot make the row look
    // proved with a pair nobody checked.
    expect(capi.calls[1]!.token).toBe(TOKEN);
    expect(decryptSecret((await storedSettings())!.accessToken, key, tokenAad(agentId))).toBe(
      TOKEN,
    );
  });

  it('remembers Meta’s refusal on the row, so the reason outlives the toast', async () => {
    // The card's red line and the contract's `error` are for exactly this: the owner presses
    // «Сохранить», Meta refuses, and by the time they reload the toast that said why is gone.
    await app.inject({
      method: 'PUT',
      url: settingsUrl(),
      cookies: owner,
      payload: { datasetId: '1234567890', accessToken: TOKEN },
    });

    capi = fakeCapi(
      new CapiError('Meta не приняла токен доступа.', 400, false, 'Invalid OAuth access token.'),
    );
    app = buildServer(env, db, { graph: fakeGraph(), capi });
    await app.ready();
    await app.inject({
      method: 'PUT',
      url: settingsUrl(),
      cookies: owner,
      payload: { datasetId: '1234567890', accessToken: 'EAA-отозванный' },
    });

    const res = await app.inject({ method: 'GET', url: settingsUrl(), cookies: owner });
    expect(res.json().error).toContain('Meta не приняла токен доступа.');
    expect(res.json().error).toContain('Invalid OAuth access token.');
  });

  it('keeps the remembered refusal free of the token Meta echoed back', async () => {
    await app.inject({
      method: 'PUT',
      url: settingsUrl(),
      cookies: owner,
      payload: { datasetId: '1234567890', accessToken: TOKEN },
    });

    capi = fakeCapi(
      new CapiError('Meta отклонила событие.', 400, false, `Malformed access token ${TOKEN}`),
    );
    app = buildServer(env, db, { graph: fakeGraph(), capi });
    await app.ready();
    await app.inject({
      method: 'PUT',
      url: settingsUrl(),
      cookies: owner,
      payload: { datasetId: '1234567890', accessToken: TOKEN },
    });

    const stored = (await storedSettings())!.error;
    expect(stored).not.toContain(TOKEN);
    expect(stored).toContain(REDACTED);
  });

  it('clears the remembered refusal once Meta accepts the pair', async () => {
    await app.inject({
      method: 'PUT',
      url: settingsUrl(),
      cookies: owner,
      payload: { datasetId: '1234567890', accessToken: TOKEN },
    });
    await db
      .update(capiSettings)
      .set({ error: 'Meta не приняла токен доступа.' })
      .where(eq(capiSettings.agentId, agentId));

    await app.inject({
      method: 'PUT',
      url: settingsUrl(),
      cookies: owner,
      payload: { datasetId: '1234567890', accessToken: TOKEN },
    });

    expect((await storedSettings())!.error).toBeNull();
  });

  it('asks Meta nothing when the request only turns sending off', async () => {
    // An owner whose token has just been revoked must still be able to stop the queue.
    // Verifying here would refuse the one request that needs no proof, and their only way
    // out would be to delete the dataset — taking the log's explanation with it.
    await app.inject({
      method: 'PUT',
      url: settingsUrl(),
      cookies: owner,
      payload: { datasetId: '1234567890', accessToken: TOKEN, enabled: true },
    });
    const before = (await storedSettings())!;

    capi = fakeCapi(new CapiError('Meta не приняла токен доступа.', 400, false));
    app = buildServer(env, db, { graph: fakeGraph(), capi });
    await app.ready();
    const res = await app.inject({
      method: 'PUT',
      url: settingsUrl(),
      cookies: owner,
      payload: { datasetId: '1234567890', enabled: false },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().enabled).toBe(false);
    expect(capi.calls).toHaveLength(0);
    const after = (await storedSettings())!;
    expect(after.enabled).toBe(false);
    // Nothing was proved, so nothing claims to have been: the stamp is the old one.
    expect(after.verifiedAt).toEqual(before.verifiedAt);
    expect(after.accessToken).toBe(before.accessToken);
  });

  it('switches off even when the credentials key no longer opens the stored token', async () => {
    await app.inject({
      method: 'PUT',
      url: settingsUrl(),
      cookies: owner,
      payload: { datasetId: '1234567890', accessToken: TOKEN, enabled: true },
    });
    // The shape of a rotated key: the sealed bytes no longer open under this agent's aad.
    await db
      .update(capiSettings)
      .set({ accessToken: encryptSecret(TOKEN, key, randomUUID()) })
      .where(eq(capiSettings.agentId, agentId));

    const res = await app.inject({
      method: 'PUT',
      url: settingsUrl(),
      cookies: owner,
      payload: { datasetId: '1234567890', enabled: false },
    });

    expect(res.statusCode).toBe(200);
    expect((await storedSettings())!.enabled).toBe(false);
  });

  it('still proves a new token, even in a request that turns sending off', async () => {
    await app.inject({
      method: 'PUT',
      url: settingsUrl(),
      cookies: owner,
      payload: { datasetId: '1234567890', accessToken: TOKEN, enabled: true },
    });

    const res = await app.inject({
      method: 'PUT',
      url: settingsUrl(),
      cookies: owner,
      payload: { datasetId: '1234567890', accessToken: 'EAA-новый', enabled: false },
    });

    expect(res.statusCode).toBe(200);
    expect(capi.calls).toHaveLength(2);
    expect(capi.calls[1]!.token).toBe('EAA-новый');
  });

  it('still proves a different dataset, even in a request that turns sending off', async () => {
    await app.inject({
      method: 'PUT',
      url: settingsUrl(),
      cookies: owner,
      payload: { datasetId: '1234567890', accessToken: TOKEN, enabled: true },
    });

    await app.inject({
      method: 'PUT',
      url: settingsUrl(),
      cookies: owner,
      payload: { datasetId: '9999999999', enabled: false },
    });

    expect(capi.calls).toHaveLength(2);
    expect(capi.calls[1]!.datasetId).toBe('9999999999');
  });

  it('refuses a first save with no token at all', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: settingsUrl(),
      cookies: owner,
      payload: { datasetId: '1234567890' },
    });

    expect(res.statusCode).toBe(400);
    expect(capi.calls).toHaveLength(0);
    expect(await storedSettings()).toBeUndefined();
  });

  it('is refused to a member', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: settingsUrl(),
      cookies: member,
      payload: { datasetId: '1234567890', accessToken: TOKEN },
    });

    expect(res.statusCode).toBe(403);
    expect(capi.calls).toHaveLength(0);
    expect(await storedSettings()).toBeUndefined();
  });
});

describe('removing the settings', () => {
  it('removes the row for an owner', async () => {
    await app.inject({
      method: 'PUT',
      url: settingsUrl(),
      cookies: owner,
      payload: { datasetId: '1234567890', accessToken: TOKEN },
    });

    const res = await app.inject({ method: 'DELETE', url: settingsUrl(), cookies: owner });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(await storedSettings()).toBeUndefined();
  });

  it('is refused to a member', async () => {
    await db.insert(capiSettings).values({
      agentId,
      datasetId: '1234567890',
      accessToken: encryptSecret(TOKEN, key, tokenAad(agentId)),
    });

    const res = await app.inject({ method: 'DELETE', url: settingsUrl(), cookies: member });

    expect(res.statusCode).toBe(403);
    expect(await storedSettings()).toBeDefined();
  });
});

describe('the log', () => {
  it('shows what was reported, for how much and to whom', async () => {
    const row = await event({ status: 'sent', sentAt: new Date('2026-09-01T10:05:00Z') });

    const res = await app.inject({ method: 'GET', url: eventsUrl(), cookies: owner });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      {
        id: row.id,
        conversationId,
        kind: 'purchase',
        status: 'sent',
        attempts: 0,
        resendable: true,
        error: null,
        sentAt: '2026-09-01T10:05:00.000Z',
        createdAt: row.createdAt.toISOString(),
        value: '15000.00',
        currency: 'KZT',
        contactName: 'Айгуль',
        contactPhone: '77085807932',
      },
    ]);
  });

  it('shows Meta’s reason in full on a failure', async () => {
    await failed();

    const res = await app.inject({ method: 'GET', url: eventsUrl(), cookies: owner });

    expect(res.json()[0].error).toContain('Invalid OAuth access token.');
  });

  it('is newest first and stops at fifty', async () => {
    for (let i = 0; i < 52; i += 1) {
      await event({ createdAt: new Date(Date.UTC(2026, 8, 1, 0, i)) });
    }

    const res = await app.inject({ method: 'GET', url: eventsUrl(), cookies: owner });
    const rows = res.json() as { createdAt: string }[];

    expect(rows).toHaveLength(50);
    expect(rows[0]!.createdAt).toBe('2026-09-01T00:51:00.000Z');
    expect(rows[49]!.createdAt).toBe('2026-09-01T00:02:00.000Z');
  });

  it('carries nothing from another agent', async () => {
    const stranger = await otherAgent();
    await event();
    await db.insert(capiEvents).values({
      agentId: stranger,
      kind: 'lead',
      eventId: `lead:${randomUUID()}`,
      payload: body(randomUUID()),
    });

    const res = await app.inject({ method: 'GET', url: eventsUrl(), cookies: owner });

    expect(res.json()).toHaveLength(1);
  });

  it('is open to a member', async () => {
    const res = await app.inject({ method: 'GET', url: eventsUrl(), cookies: member });
    expect(res.statusCode).toBe(200);
  });
});

describe('resending one by hand', () => {
  it('puts a failed event back in the queue with the same event_id', async () => {
    const row = await failed();

    const res = await app.inject({ method: 'POST', url: resendUrl(row.id), cookies: owner });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('pending');
    expect(res.json().attempts).toBe(0);
    expect(res.json().error).toBeNull();

    const after = await rowOf(row.id);
    expect(after.status).toBe('pending');
    expect(after.attempts).toBe(0);
    // The whole reason the button is safe: Meta counts one conversion per event_id.
    expect(after.eventId).toBe(row.eventId);
    expect(after.payload).toBe(row.payload);
  });

  it('clears the last attempt, so the backoff does not hold the button back', async () => {
    const row = await failed();

    await app.inject({ method: 'POST', url: resendUrl(row.id), cookies: owner });

    // The drain measures its widening gap from `last_attempt_at`. Left as it was, a row
    // whose fifth attempt was minutes ago would sit unclaimed for two more hours after an
    // owner pressed «Отправить снова».
    expect((await rowOf(row.id)).lastAttemptAt).toBeNull();
  });

  it('re-queues an event Meta already accepted', async () => {
    const row = await event({
      status: 'sent',
      sentAt: new Date('2026-09-01T10:05:00Z'),
      fbtraceId: 'A-fbtrace',
    });

    const res = await app.inject({ method: 'POST', url: resendUrl(row.id), cookies: owner });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('pending');
    expect(res.json().sentAt).toBeNull();
  });

  it('re-queues one that was skipped because the dataset was off', async () => {
    const row = await event({
      status: 'skipped',
      error: 'Не отправлено: отправка в Meta отключена в интеграциях.',
    });

    const res = await app.inject({ method: 'POST', url: resendUrl(row.id), cookies: owner });

    expect(res.statusCode).toBe(200);
    expect((await rowOf(row.id)).status).toBe('pending');
  });

  it('refuses one that could never be built, and leaves it skipped', async () => {
    const row = await unreportable();

    const res = await app.inject({ method: 'POST', url: resendUrl(row.id), cookies: owner });

    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain('ctwa_clid');
    // Flipped to pending, the drain would post an empty body to Meta on the owner's behalf.
    const after = await rowOf(row.id);
    expect(after.status).toBe('skipped');
    expect(after.attempts).toBe(0);
  });

  it('is open to a member', async () => {
    const row = await failed();

    const res = await app.inject({ method: 'POST', url: resendUrl(row.id), cookies: member });

    expect(res.statusCode).toBe(200);
    expect((await rowOf(row.id)).status).toBe('pending');
  });

  it('answers 404 for another agent’s event', async () => {
    const stranger = await otherAgent();
    const [row] = await db
      .insert(capiEvents)
      .values({
        agentId: stranger,
        kind: 'lead',
        eventId: `lead:${randomUUID()}`,
        payload: body(randomUUID()),
      })
      .returning();

    const res = await app.inject({ method: 'POST', url: resendUrl(row!.id), cookies: owner });

    expect(res.statusCode).toBe(404);
    expect((await rowOf(row!.id)).status).toBe('pending');
  });

  it('answers 404 for an id that is not a uuid', async () => {
    const res = await app.inject({ method: 'POST', url: resendUrl('nonsense'), cookies: owner });
    expect(res.statusCode).toBe(404);
  });
});
