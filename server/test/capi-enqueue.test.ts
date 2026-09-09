import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import type { Db } from '../src/db/client.js';
import {
  agents,
  capiEvents,
  capiSettings,
  contacts,
  conversations,
  messages,
  orders,
  stages,
  whatsappNumbers,
} from '../src/db/schema.js';
import { runTurn } from '../src/lib/ai/turn.js';
import { leadEventId, purchaseEventId } from '../src/lib/capi/events.js';
import { seedFunnel } from '../src/lib/funnel.js';
import { createAccountWithOwner } from '../src/lib/provision.js';
import { encryptSecret } from '../src/lib/secret-box.js';
import { withDb } from './helpers/db.js';
import { testEnv } from './helpers/env.js';
import { fakeGraph } from './helpers/fake-graph.js';
import { fakeModel } from './helpers/fake-model.js';

const env = testEnv();
const key = Buffer.from(env.CREDENTIALS_KEY, 'base64');
const PASSWORD = 'correct-horse-battery';
const CLID = 'ARAaXQ_click_to_whatsapp';
const OPENROUTER_KEY = 'sk-or-v1-0123456789abcdef';

let app: FastifyInstance;
let db: Db;
let accountId: string;
let agentId: string;
let numberId: string;
/** A lead that came from a Click-to-WhatsApp ad, so Meta can attribute it. */
let adConversationId: string;
/** A lead that walked in off the street. Nothing about it is reportable. */
let plainConversationId: string;
/** A third ad-sourced lead, kept for the turn so its `event_id` is its own. */
let aiConversationId: string;
let jar: Record<string, string>;

async function login(email: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: PASSWORD },
  });
  const cookie = res.cookies[0]!;
  return { [cookie.name]: cookie.value };
}

/** Every queued event, oldest first. */
const queued = () => db.select().from(capiEvents).orderBy(asc(capiEvents.createdAt));

const orderRow = async (orderId: string) => {
  const [row] = await db.select().from(orders).where(eq(orders.id, orderId));
  return row!;
};

const conversationRow = async (conversationId: string) => {
  const [row] = await db.select().from(conversations).where(eq(conversations.id, conversationId));
  return row!;
};

const stageOfKind = async (kind: string) => {
  const rows = await db.select().from(stages).where(eq(stages.agentId, agentId));
  return rows.find((row) => row.kind === kind)!;
};

/** Records an order on a conversation and returns its id. */
async function record(conversationId: string, payload: Record<string, unknown>) {
  const res = await app.inject({
    method: 'POST',
    url: `/api/agents/${agentId}/conversations/${conversationId}/orders`,
    cookies: jar,
    payload,
  });
  return { res, id: res.json().orders?.at(-1)?.id as string };
}

const patchOrder = (orderId: string, payload: Record<string, unknown>) =>
  app.inject({
    method: 'PATCH',
    url: `/api/agents/${agentId}/orders/${orderId}`,
    cookies: jar,
    payload,
  });

const moveTo = (conversationId: string, stageId: string | null) =>
  app.inject({
    method: 'PATCH',
    url: `/api/agents/${agentId}/conversations/${conversationId}/lead`,
    cookies: jar,
    payload: { stageId },
  });

/** A conversation with a contact of its own, so each lead has its own phone. */
async function conversation(phone: string, ctwaClid: string | null, stageId?: string) {
  const [contact] = await db
    .insert(contacts)
    .values({ agentId, phone, name: 'Айгуль' })
    .returning();
  const [row] = await db
    .insert(conversations)
    .values({
      agentId,
      contactId: contact!.id,
      whatsappNumberId: numberId,
      ctwaClid,
      stageId: stageId ?? null,
      stageSetAt: stageId === undefined ? null : new Date(),
      lastInboundAt: new Date(Date.now() - 60_000),
      lastMessageAt: new Date(Date.now() - 60_000),
    })
    .returning();
  return row!.id;
}

/**
 * The same database with `capi_events` unwritable.
 *
 * Queueing must never fail the action it decorates, and the honest way to prove that is to
 * break what queueing writes to rather than to stub the function out: a stub proves the stub
 * swallows, not that the code does.
 */
function withoutCapiEvents(real: Db): Db {
  return new Proxy(real, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (prop !== 'insert') return typeof value === 'function' ? value.bind(target) : value;
      return (table: unknown) => {
        if (table === capiEvents) throw new Error('capi_events is unavailable');
        return (value as (table: unknown) => unknown).call(target, table);
      };
    },
  }) as Db;
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

  // Minted here rather than read back: the OpenRouter key is sealed against the id, so the
  // row has to carry the sealed value from the start.
  agentId = randomUUID();
  await db.insert(agents).values({
    id: agentId,
    accountId,
    name: 'Сафина',
    aiEnabled: true,
    openrouterKey: encryptSecret(OPENROUTER_KEY, key, agentId),
  });
  await seedFunnel(db, agentId);

  const [number] = await db
    .insert(whatsappNumbers)
    .values({
      agentId,
      phoneNumberId: '136',
      wabaId: 'waba',
      displayPhone: '+7 708 580 79 32',
      accessToken: encryptSecret('EAAG-token', key, '136'),
    })
    .returning();
  numberId = number!.id;

  const first = await stageOfKind('active');
  adConversationId = await conversation('77085807932', CLID, first.id);
  plainConversationId = await conversation('77770000001', null, first.id);
  aiConversationId = await conversation('77770000002', CLID, first.id);

  await db.insert(messages).values({
    conversationId: aiConversationId,
    direction: 'in',
    author: 'client',
    kind: 'text',
    body: 'Сколько стоит доставка?',
    sentAt: new Date(Date.now() - 60_000),
  });

  await db.insert(capiSettings).values({
    agentId,
    datasetId: '1234567890',
    accessToken: encryptSecret('EAA-capi-token', key, agentId),
    enabled: true,
  });

  app = buildServer(env, db, { graph: fakeGraph() });
  await app.ready();
  jar = await login('owner@example.com');
});

afterEach(async () => {
  await app.close();
});

describe('an order becoming paid', () => {
  it('queues one purchase carrying the amount, the currency and the time it was paid', async () => {
    const { id } = await record(adConversationId, { amount: '450000.50' });
    expect(await queued()).toHaveLength(0);

    const res = await patchOrder(id, { status: 'paid' });
    expect(res.statusCode).toBe(200);

    const rows = await queued();
    expect(rows).toHaveLength(1);
    const event = rows[0]!;
    expect(event.kind).toBe('purchase');
    expect(event.status).toBe('pending');
    expect(event.error).toBeNull();
    expect(event.attempts).toBe(0);
    expect(event.sentAt).toBeNull();
    expect(event.eventId).toBe(purchaseEventId(id));
    expect(event.orderId).toBe(id);
    expect(event.conversationId).toBe(adConversationId);

    // Matched as text rather than parsed: a `JSON.parse` here would turn the amount into a
    // double and hide the very thing the column exists to keep.
    const { paidAt } = await orderRow(id);
    expect(event.payload).toContain('"event_name":"Purchase"');
    expect(event.payload).toContain('"value":450000.50');
    expect(event.payload).toContain('"currency":"KZT"');
    expect(event.payload).toContain(`"event_time":${Math.floor(paidAt!.getTime() / 1000)}`);
    expect(event.payload).toContain(`"ctwa_clid":"${CLID}"`);
  });

  it('queues a purchase for an order recorded as paid from the start', async () => {
    const { id } = await record(adConversationId, { amount: '1000', status: 'paid' });

    const rows = await queued();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.eventId).toBe(purchaseEventId(id));
    expect(rows[0]!.status).toBe('pending');
  });

  it('queues nothing more when the same order is marked paid again', async () => {
    const { id } = await record(adConversationId, { amount: '1000' });
    await patchOrder(id, { status: 'paid' });
    await patchOrder(id, { status: 'paid' });
    await patchOrder(id, { comment: 'Оплатили картой' });

    expect(await queued()).toHaveLength(1);
  });

  it('queues nothing more when a paid order is unpaid and paid again', async () => {
    const { id } = await record(adConversationId, { amount: '1000', status: 'paid' });
    await patchOrder(id, { status: 'pending' });
    await patchOrder(id, { status: 'paid' });

    expect(await queued()).toHaveLength(1);
  });

  it('records why a lead that did not come from an ad is not reported', async () => {
    const { id } = await record(plainConversationId, { amount: '1000', status: 'paid' });

    const rows = await queued();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('skipped');
    expect(rows[0]!.eventId).toBe(purchaseEventId(id));
    expect(rows[0]!.error).toContain('ctwa_clid');
  });

  it('records that the dataset was never configured', async () => {
    await db.delete(capiSettings).where(eq(capiSettings.agentId, agentId));

    await record(adConversationId, { amount: '1000', status: 'paid' });

    const rows = await queued();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('skipped');
    expect(rows[0]!.error).toContain('не настроен');
  });

  it('records that sending was turned off, with its own reason', async () => {
    await db
      .update(capiSettings)
      .set({ enabled: false })
      .where(eq(capiSettings.agentId, agentId));

    await record(adConversationId, { amount: '1000', status: 'paid' });

    const rows = await queued();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('skipped');
    expect(rows[0]!.error).toContain('отключена');
    expect(rows[0]!.error).not.toContain('ctwa_clid');
  });

  it('still marks the order paid when queueing cannot write at all', async () => {
    await app.close();
    app = buildServer(env, withoutCapiEvents(db), { graph: fakeGraph() });
    await app.ready();

    const { id } = await record(adConversationId, { amount: '1000' });
    const res = await patchOrder(id, { status: 'paid' });

    expect(res.statusCode).toBe(200);
    expect(res.json().orders[0].status).toBe('paid');
    expect((await orderRow(id)).paidAt).not.toBeNull();
    expect(await queued()).toHaveLength(0);
  });
});

describe('a lead reaching a qualified stage', () => {
  it('queues one lead event, stamped with the moment it got there', async () => {
    const qualified = await stageOfKind('qualified');

    const res = await moveTo(adConversationId, qualified.id);
    expect(res.statusCode).toBe(200);

    const rows = await queued();
    expect(rows).toHaveLength(1);
    const event = rows[0]!;
    expect(event.kind).toBe('lead');
    expect(event.status).toBe('pending');
    expect(event.eventId).toBe(leadEventId(adConversationId));
    expect(event.conversationId).toBe(adConversationId);
    expect(event.orderId).toBeNull();

    const { stageSetAt } = await conversationRow(adConversationId);
    expect(event.payload).toContain('"event_name":"Lead"');
    expect(event.payload).toContain(`"event_time":${Math.floor(stageSetAt!.getTime() / 1000)}`);
    expect(event.payload).not.toContain('custom_data');
  });

  it('queues nothing when the stage does not qualify the lead', async () => {
    const rows = await db.select().from(stages).where(eq(stages.agentId, agentId));
    const other = rows.find((row) => row.kind === 'active' && row.position > 0)!;

    await moveTo(adConversationId, other.id);

    expect(await queued()).toHaveLength(0);
  });

  it('queues nothing more when the lead comes back to a qualified stage', async () => {
    const qualified = await stageOfKind('qualified');
    const success = await stageOfKind('success');

    await moveTo(adConversationId, qualified.id);
    await moveTo(adConversationId, success.id);
    await moveTo(adConversationId, qualified.id);

    expect(await queued()).toHaveLength(1);
  });

  it('records why a lead that did not come from an ad is not reported', async () => {
    const qualified = await stageOfKind('qualified');

    await moveTo(plainConversationId, qualified.id);

    const rows = await queued();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('skipped');
    expect(rows[0]!.eventId).toBe(leadEventId(plainConversationId));
    expect(rows[0]!.error).toContain('ctwa_clid');
  });

  it("queues the agent's own move too, because it takes the operator's road", async () => {
    const qualified = await stageOfKind('qualified');
    const model = fakeModel(
      JSON.stringify({
        reply: 'Понял, подберу вариант.',
        stageId: qualified.id,
        fields: {},
        handoff: null,
        usedItemIds: [],
      }),
    );

    const result = await runTurn(
      db,
      { model, graph: fakeGraph(), key },
      { agentId, conversationId: aiConversationId },
    );
    expect(result.stageId).toBe(qualified.id);

    const rows = await queued();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('lead');
    expect(rows[0]!.eventId).toBe(leadEventId(aiConversationId));
    expect(rows[0]!.status).toBe('pending');
  });
});
