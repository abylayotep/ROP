/**
 * Воронка, источники и деньги за период.
 *
 * Every lead here is moved through the operator's real PATCH route rather than by inserting
 * a row into `stage_transitions`. The funnel is arithmetic over what the cabinet recorded,
 * and a fixture that wrote its own transitions would be testing the arithmetic against
 * history no writer produces — the one way this suite could pass while the screen shows
 * numbers nobody's board could ever generate.
 *
 * Orders are inserted directly: `orders` has been written since stage 3 and nothing about
 * the order form is under test here. What is under test is that no amount becomes a double
 * on the way out, which is why one case sums past what `numeric(14,2)` can hold at all.
 */
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import type { Db } from '../src/db/client.js';
import {
  agents,
  contacts,
  conversations,
  orders,
  stages,
  stageTransitions,
  whatsappNumbers,
} from '../src/db/schema.js';
import { seedFunnel } from '../src/lib/funnel.js';
import { addMember, createAccountWithOwner } from '../src/lib/provision.js';
import { encryptSecret } from '../src/lib/secret-box.js';
import { withDb } from './helpers/db.js';
import { testEnv } from './helpers/env.js';
import { fakeGraph } from './helpers/fake-graph.js';

const env = testEnv();
const key = Buffer.from(env.CREDENTIALS_KEY, 'base64');
const PASSWORD = 'correct-horse-battery';
const DAY = 24 * 60 * 60 * 1000;

/** A moment `days` days in the past, for a fixture that has to fall outside a window. */
const daysAgo = (days: number) => new Date(Date.now() - days * DAY);

type Fixture = {
  agentId: string;
  numberId: string;
  /** Every default stage of the agent, by name. */
  stage: (name: string) => { id: string; position: number };
};

let db: Db;
let app: FastifyInstance;
let fixture: Fixture;
let jar: Record<string, string>;

const agentId = () => fixture.agentId;

async function login(email = 'owner@example.com') {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: PASSWORD },
  });
  const cookie = res.cookies[0]!;
  return { [cookie.name]: cookie.value };
}

/**
 * A company with an agent, a number and the default nine-stage funnel.
 *
 * The seeded funnel is used rather than a hand-written one on purpose: «Отказ» sits at
 * position 8, *after* «Продажа», and that ordering is exactly what the chain has to refuse
 * to walk through. A three-stage fixture with the refusal at the end would agree with a
 * route that had no such rule.
 */
async function seedAgent(company: string, email: string): Promise<Fixture> {
  const { accountId } = await createAccountWithOwner(db, {
    company,
    email,
    name: 'Владелец',
    initials: 'ВЛ',
    password: PASSWORD,
  });
  const [agent] = await db.insert(agents).values({ accountId, name: company }).returning();
  await seedFunnel(db, agent!.id);

  const suffix = randomUUID().slice(0, 8);
  const [number] = await db
    .insert(whatsappNumbers)
    .values({
      agentId: agent!.id,
      phoneNumberId: `pnid-${suffix}`,
      wabaId: `waba-${suffix}`,
      displayPhone: '+7 708 580 79 32',
      accessToken: encryptSecret('EAAG-token', key, `pnid-${suffix}`),
    })
    .returning();

  const funnel = await db.select().from(stages).where(eq(stages.agentId, agent!.id));
  return {
    agentId: agent!.id,
    numberId: number!.id,
    stage: (name) => {
      const row = funnel.find((stage) => stage.name === name);
      if (!row) throw new Error(`no stage named ${name}`);
      return { id: row.id, position: row.position };
    },
  };
}

/** One conversation on the agent's number, unsorted unless the caller says otherwise. */
async function addLead(
  options: {
    on?: Fixture;
    createdAt?: Date;
    ctwaClid?: string | null;
    adSourceId?: string | null;
    adSourceType?: string | null;
    adHeadline?: string | null;
    stageId?: string | null;
  } = {},
): Promise<string> {
  const on = options.on ?? fixture;
  const [contact] = await db
    .insert(contacts)
    .values({ agentId: on.agentId, phone: `7777${randomUUID().slice(0, 8)}` })
    .returning();
  const [conversation] = await db
    .insert(conversations)
    .values({
      agentId: on.agentId,
      contactId: contact!.id,
      whatsappNumberId: on.numberId,
      stageId: options.stageId ?? null,
      ctwaClid: options.ctwaClid ?? null,
      adSourceId: options.adSourceId ?? null,
      adSourceType: options.adSourceType ?? null,
      adHeadline: options.adHeadline ?? null,
      ...(options.createdAt ? { createdAt: options.createdAt } : {}),
    })
    .returning();
  return conversation!.id;
}

/** The operator's own move, through the route the board really calls. */
async function move(conversationId: string, stageId: string | null, on = fixture, cookies = jar) {
  const res = await app.inject({
    method: 'PATCH',
    url: `/api/agents/${on.agentId}/conversations/${conversationId}/lead`,
    cookies,
    payload: { stageId },
  });
  expect(res.statusCode).toBe(200);
}

async function addOrder(
  conversationId: string,
  amount: string,
  options: {
    on?: Fixture;
    status?: string;
    paidAt?: Date | null;
    currency?: string;
  } = {},
) {
  const on = options.on ?? fixture;
  const status = options.status ?? 'paid';
  await db.insert(orders).values({
    agentId: on.agentId,
    conversationId,
    amount,
    currency: options.currency ?? 'KZT',
    status,
    paidAt: options.paidAt === undefined ? (status === 'paid' ? new Date() : null) : options.paidAt,
  });
}

const report = (query = '', id = agentId(), cookies = jar) =>
  app.inject({
    method: 'GET',
    url: `/api/agents/${id}/stats/period${query}`,
    cookies,
  });

/**
 * The report, insisting on a 200.
 *
 * A route that answers 500 hands back a deliberately generic message, so a test that read
 * `.json()` regardless would fail thirty assertions on `undefined` and name none of them.
 * This raises with the status and the body instead.
 */
const body = async (query = '') => {
  const res = await report(query);
  if (res.statusCode !== 200) throw new Error(`${res.statusCode} ${res.body}`);
  return res.json();
};

/** One step of the answered chain, by stage name. */
const step = (answer: { funnel: { name: string }[] }, name: string) =>
  answer.funnel.find((row) => row.name === name) as
    | { name: string; entered: number; conversion: number | null; position: number }
    | undefined;

beforeEach(async () => {
  db = await withDb();
  fixture = await seedAgent('Сафина', 'owner@example.com');
  await addMember(db, {
    company: 'Сафина',
    email: 'member@example.com',
    name: 'Оператор',
    initials: 'ОП',
    password: PASSWORD,
    role: 'member',
  });

  app = buildServer(env, db, { graph: fakeGraph() });
  await app.ready();
  jar = await login();
});

afterEach(async () => {
  await app.close();
});

describe('the funnel over a period', () => {
  it('answers the window it counted from, the day recording began, and the default week', async () => {
    const answer = await body();

    expect(answer.period).toBe('week');
    const since = Date.parse(answer.since);
    expect(Number.isNaN(since)).toBe(false);
    // Seven days back, give or take the milliseconds the request itself took.
    expect(Math.abs(Date.now() - 7 * DAY - since)).toBeLessThan(10_000);
    expect(Number.isNaN(Date.parse(answer.stageHistorySince))).toBe(false);
    expect(answer.currency).toBe('KZT');
  });

  it('answers an empty chain when nothing moved, rather than a column of zeros', async () => {
    await addLead();

    const answer = await body();
    // Empty and not nine zeros: a chain of zeros reads as «ни один лид никуда не дошёл»,
    // while the truth is that nobody was asked to move anybody.
    expect(answer.funnel).toEqual([]);
    expect(answer.failureEntries).toBe(0);
    expect(answer.backwardMoves).toBe(0);
    expect(answer.deletedStageEntries).toBe(0);
    expect(answer.deletedStageNames).toEqual([]);
  });

  it('leaves conversion null on the first step and null where the previous step is empty', async () => {
    const lead = await addLead();
    // Straight past «В диалоге»: the lead entered two stages and no others.
    await move(lead, fixture.stage('Новый лид').id);
    await move(lead, fixture.stage('Интерес проявлен').id);

    const answer = await body();
    expect(step(answer, 'Новый лид')).toMatchObject({ entered: 1, conversion: null });
    // Nobody entered «В диалоге», so it is 0 out of 1 — a share that exists.
    expect(step(answer, 'В диалоге')).toMatchObject({ entered: 0, conversion: 0 });
    // And the step after it has nothing to divide by: null, never 0%.
    expect(step(answer, 'Интерес проявлен')).toMatchObject({ entered: 1, conversion: null });
  });

  it('does not count a lead into the stages it skipped', async () => {
    const lead = await addLead();
    await move(lead, fixture.stage('Новый лид').id);
    await move(lead, fixture.stage('Продажа').id);

    const answer = await body();
    expect(step(answer, 'Новый лид')!.entered).toBe(1);
    expect(step(answer, 'Продажа')!.entered).toBe(1);
    // The three in between were never entered. A monotonic closure would print them as
    // entered too, and the conversion into «Продажа» would read as 100% of a stage the
    // lead never stood in.
    expect(step(answer, 'Квалифицирован')!.entered).toBe(0);
    expect(step(answer, 'Предложение отправлено')!.entered).toBe(0);
    expect(step(answer, 'Счёт отправлен')!.entered).toBe(0);
  });

  it('counts a lead once in a stage it entered twice', async () => {
    const lead = await addLead();
    await move(lead, fixture.stage('Новый лид').id);
    await move(lead, fixture.stage('В диалоге').id);
    await move(lead, fixture.stage('Новый лид').id);

    const answer = await body();
    // Three transitions, one lead: the column it came back to must not show two.
    expect(await transitionCount()).toBe(3);
    expect(step(answer, 'Новый лид')!.entered).toBe(1);
    expect(step(answer, 'В диалоге')!.entered).toBe(1);
  });

  it('counts a backwards move in the target stage and in backwardMoves', async () => {
    const lead = await addLead();
    await move(lead, fixture.stage('Новый лид').id);
    await move(lead, fixture.stage('В диалоге').id);
    await move(lead, fixture.stage('Новый лид').id);

    const answer = await body();
    // One move to an earlier position. The first move has no previous position at all and
    // is not one of them.
    expect(answer.backwardMoves).toBe(1);
    expect(step(answer, 'Новый лид')!.entered).toBe(1);
  });

  it('counts backwards moves per move, not per lead', async () => {
    const lead = await addLead();
    await move(lead, fixture.stage('В диалоге').id);
    await move(lead, fixture.stage('Новый лид').id);
    await move(lead, fixture.stage('В диалоге').id);
    await move(lead, fixture.stage('Новый лид').id);

    // How often it happens is the question, so one lead sent back twice is two.
    expect((await body()).backwardMoves).toBe(2);
  });

  it('keeps a failure stage out of the chain and reports it beside it', async () => {
    const lead = await addLead();
    await move(lead, fixture.stage('Новый лид').id);
    await move(lead, fixture.stage('Отказ').id);

    const answer = await body();
    // «Отказ» is at position 8, after «Продажа» at 7. In the chain it would read as the
    // step a sale leads to.
    expect(answer.funnel.map((row: { name: string }) => row.name)).not.toContain('Отказ');
    expect(answer.funnel).toHaveLength(8);
    expect(answer.failureEntries).toBe(1);
  });

  it('counts a refused lead once however many times it was refused', async () => {
    const lead = await addLead();
    await move(lead, fixture.stage('Отказ').id);
    await move(lead, fixture.stage('Новый лид').id);
    await move(lead, fixture.stage('Отказ').id);

    expect((await body()).failureEntries).toBe(1);
  });

  it('orders the chain by position, whatever order the moves happened in', async () => {
    const lead = await addLead();
    await move(lead, fixture.stage('Счёт отправлен').id);
    await move(lead, fixture.stage('Новый лид').id);

    const answer = await body();
    const positions = answer.funnel.map((row: { position: number }) => row.position);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(answer.funnel[0]!.name).toBe('Новый лид');
  });

  it('counts entries into a stage that has since been deleted, and names it', async () => {
    const lead = await addLead();
    const doomed = fixture.stage('Интерес проявлен');
    await move(lead, doomed.id);
    // Emptied first: the delete route refuses a stage that still holds leads.
    await move(lead, fixture.stage('Новый лид').id);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/agents/${agentId()}/stages/${doomed.id}`,
      cookies: jar,
    });
    expect(deleted.statusCode).toBe(200);

    const answer = await body();
    // The entry has no column left to sit in. Counted and named rather than dropped, so a
    // funnel whose totals do not add up says why.
    expect(answer.deletedStageEntries).toBe(1);
    expect(answer.deletedStageNames).toEqual(['Интерес проявлен']);
    expect(answer.funnel.map((row: { name: string }) => row.name)).not.toContain(
      'Интерес проявлен',
    );
  });

  it('excludes a move older than the window and keeps the one inside it', async () => {
    const old = await addLead();
    const fresh = await addLead();
    await move(old, fixture.stage('Новый лид').id);
    await move(fresh, fixture.stage('Новый лид').id);

    // Backdated afterwards rather than inserted with a date: `occurred_at` is written by
    // the route, and the only honest way to age a real transition is to age it.
    await db
      .update(stageTransitions)
      .set({ occurredAt: daysAgo(10) })
      .where(eq(stageTransitions.conversationId, old));

    expect(step(await body('?period=week'), 'Новый лид')!.entered).toBe(1);
    // The same move, in a window wide enough to hold it.
    expect(step(await body('?period=month'), 'Новый лид')!.entered).toBe(2);
  });

  it('counts no other agent’s movement', async () => {
    const other = await seedAgent('Тандем', 'stranger@example.com');
    const strangerJar = await login('stranger@example.com');
    const theirs = await addLead({ on: other });
    await move(theirs, other.stage('Новый лид').id, other, strangerJar);

    const mine = await addLead();
    await move(mine, fixture.stage('Новый лид').id);

    const answer = await body();
    expect(step(answer, 'Новый лид')!.entered).toBe(1);
    expect(answer.funnel.map((row: { name: string }) => row.name)).toHaveLength(8);
  });
});

describe('the sources', () => {
  it('counts the cohort created in the window and how much of it came from ads', async () => {
    await addLead({ adSourceId: 'ad-1', ctwaClid: 'clid-1' });
    await addLead({ ctwaClid: 'clid-2' });
    await addLead();
    // Outside the window: the click happened before it and belongs to another period.
    await addLead({ adSourceId: 'ad-1', ctwaClid: 'clid-old', createdAt: daysAgo(10) });

    const answer = await body();
    expect(answer.newLeads).toBe(3);
    expect(answer.leadsFromAds).toBe(2);
    // The third lead is neither, and is exactly the difference between the two counts.
    expect(answer.newLeads - answer.leadsFromAds).toBe(1);
  });

  it('groups by the ad and reports its headline, clicks and sales', async () => {
    const won = await addLead({
      adSourceId: 'ad-1',
      adSourceType: 'ad',
      adHeadline: 'Двери со скидкой',
      ctwaClid: 'clid-1',
    });
    await addLead({
      adSourceId: 'ad-1',
      adSourceType: 'ad',
      adHeadline: 'Двери со скидкой',
      ctwaClid: null,
    });
    await move(won, fixture.stage('Продажа').id);

    const answer = await body();
    expect(answer.sources).toHaveLength(1);
    expect(answer.sources[0]).toMatchObject({
      sourceId: 'ad-1',
      sourceType: 'ad',
      headline: 'Двери со скидкой',
      leads: 2,
      withClickId: 1,
      // Standing in a stage of kind `success` right now — a fact about the present, not a
      // transition, so it is available for a lead that moved before recording began.
      won: 1,
    });
  });

  it('collapses a click with no ad id into one row, and leaves the rest out', async () => {
    await addLead({ ctwaClid: 'clid-1' });
    await addLead({ ctwaClid: 'clid-2' });
    await addLead();

    const answer = await body();
    expect(answer.sources).toHaveLength(1);
    // One row, not two, and not a missing one: the click happened and is worth counting.
    expect(answer.sources[0]).toMatchObject({ sourceId: null, leads: 2, withClickId: 2 });
  });

  it('orders the biggest ad first and breaks a tie on the id', async () => {
    await addLead({ adSourceId: 'ad-b' });
    await addLead({ adSourceId: 'ad-b' });
    await addLead({ adSourceId: 'ad-a' });
    await addLead({ adSourceId: 'ad-c' });

    const answer = await body();
    expect(answer.sources.map((row: { sourceId: string }) => row.sourceId)).toEqual([
      'ad-b',
      'ad-a',
      'ad-c',
    ]);
  });

  it('credits an ad with a payment that landed outside the window', async () => {
    const lead = await addLead({ adSourceId: 'ad-1', ctwaClid: 'clid-1' });
    // The lead is this week's; the payment is not. `paidTotal` on a source takes every paid
    // order of the cohort whatever its `paid_at`, which is what lets an ad keep the credit
    // for a sale that closed in another period.
    await addOrder(lead, '150000.00', { paidAt: daysAgo(10) });

    const answer = await body();
    expect(answer.sources[0]!.paidTotal).toBe('150000.00');
    // And the money card, which counts by `paid_at`, has nothing in this window at all.
    expect(answer.money).toBeNull();
  });

  it('counts no other agent’s conversations or orders', async () => {
    const other = await seedAgent('Тандем', 'stranger@example.com');
    const theirs = await addLead({ on: other, adSourceId: 'ad-1', ctwaClid: 'clid-1' });
    await addOrder(theirs, '500000.00', { on: other });

    await addLead({ adSourceId: 'ad-1', ctwaClid: 'clid-2' });

    const answer = await body();
    expect(answer.newLeads).toBe(1);
    expect(answer.sources).toHaveLength(1);
    expect(answer.sources[0]!.paidTotal).toBe('0.00');
    expect(answer.money).toBeNull();
  });
});

describe('the money', () => {
  it('answers null when nothing was paid, and ignores a pending and a cancelled order', async () => {
    const lead = await addLead();
    await addOrder(lead, '100000.00', { status: 'pending', paidAt: null });
    await addOrder(lead, '200000.00', { status: 'cancelled', paidAt: null });

    // Null and not a row of zeros: zeros read as a fact about the business, and «нет
    // оплаченных заказов» is not one.
    expect((await body()).money).toBeNull();
  });

  it('sums, averages and divides exactly, with no amount ever a number', async () => {
    const lead = await addLead();
    // 999999999.99 + 0.01 is a sum a double cannot hold: it lands on 1000000000.0000001
    // in float64 and would print a cent that does not exist.
    await addOrder(lead, '999999999.99');
    await addOrder(lead, '0.01');

    const answer = await body();
    expect(answer.money.paidOrders).toBe(2);
    expect(answer.money.paidTotal).toBe('1000000000.00');
    expect(typeof answer.money.paidTotal).toBe('string');
    expect(answer.money.averageOrder).toBe('500000000.00');
    // One lead in the window, so the per-lead figure is the whole total.
    expect(answer.money.revenuePerLead).toBe('1000000000.00');
  });

  it('holds a total that numeric(14,2) could not, which is why the cast is wider', async () => {
    const lead = await addLead();
    // Two amounts at the ceiling of the column. Their sum has thirteen digits before the
    // point and the column holds twelve.
    await addOrder(lead, '999999999999.99');
    await addOrder(lead, '999999999999.99');

    // The guard is not decorative, and this is the proof: the very same sum cast back to
    // the column's own type raises, and `numeric field overflow` from an aggregate fails
    // the whole request rather than one card. Read off `cause`, because the driver's own
    // message is what names the failure — the wrapper above it only repeats the SQL.
    const refused = await db
      .execute(
        sql`select (sum(o.amount))::numeric(14,2) as total from orders o
            where o.agent_id = ${agentId()} and o.status = 'paid'`,
      )
      .then(
        () => 'the narrow cast accepted the sum',
        (error: { cause?: { message?: string } }) => error.cause?.message ?? String(error),
      );
    expect(refused).toMatch(/numeric field overflow/i);

    const answer = await body();
    expect(answer.money.paidTotal).toBe('1999999999999.98');
    expect(answer.money.averageOrder).toBe('999999999999.99');
  });

  it('excludes an order in another currency from the sums and counts it', async () => {
    const lead = await addLead();
    await addOrder(lead, '100000.00');
    await addOrder(lead, '900000.00', { currency: 'RUB' });

    const answer = await body();
    // An amount in another currency added into this sum would be a number labelled with a
    // unit it is not in.
    expect(answer.money.paidOrders).toBe(1);
    expect(answer.money.paidTotal).toBe('100000.00');
    expect(answer.money.otherCurrencyOrders).toBe(1);
  });

  it('leaves the per-lead figure null when the window brought no leads at all', async () => {
    // The lead is older than the window; the payment is inside it.
    const lead = await addLead({ createdAt: daysAgo(10) });
    await addOrder(lead, '400000.00');

    const answer = await body();
    expect(answer.newLeads).toBe(0);
    expect(answer.money.paidTotal).toBe('400000.00');
    // Null, not «0 ₸ с лида»: dividing by no leads has no answer, and zero is not it.
    expect(answer.money.revenuePerLead).toBeNull();
  });

  it('counts only payments made inside the window', async () => {
    const lead = await addLead();
    await addOrder(lead, '100000.00');
    await addOrder(lead, '700000.00', { paidAt: daysAgo(10) });

    expect((await body('?period=week')).money.paidTotal).toBe('100000.00');
    expect((await body('?period=month')).money.paidTotal).toBe('800000.00');
  });
});

describe('the route itself', () => {
  it('refuses an unknown period', async () => {
    const res = await report('?period=quarter');
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('Неизвестный период');
  });

  it('accepts each of the three periods and answers the one it used', async () => {
    for (const period of ['day', 'week', 'month'] as const) {
      const answer = await body(`?period=${period}`);
      expect(answer.period).toBe(period);
    }
  });

  it('answers 404 for another account’s agent, and for a malformed id', async () => {
    const other = await seedAgent('Тандем', 'stranger@example.com');
    // 404 and not 403: a 403 would confirm the agent exists to someone with no business
    // knowing that.
    expect((await report('', other.agentId)).statusCode).toBe(404);
    expect((await report('', 'не-uuid')).statusCode).toBe(404);
  });

  it('answers a member, not the owner only', async () => {
    const memberJar = await login('member@example.com');
    const res = await report('', agentId(), memberJar);
    expect(res.statusCode).toBe(200);
  });
});

/** How many transitions the fixture's agent has recorded in total. */
async function transitionCount(): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(stageTransitions)
    .where(eq(stageTransitions.agentId, agentId()));
  // Certain: an aggregate with no `group by` returns exactly one row.
  return rows[0]!.count;
}
