import { seedOrders } from './helpers/kaspi.js';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import {
  agents,
  contacts,
  conversations,
  leadFields,
  leadValues,
  notes,
  orders,
  stages,
  whatsappNumbers,
} from '../src/db/schema.js';
import { addMember, createAccountWithOwner } from '../src/lib/provision.js';
import { sumAmounts } from '../src/api/leads.js';
import { withDb } from './helpers/db.js';
import { testEnv } from './helpers/env.js';
import { fakeGraph } from './helpers/fake-graph.js';

const env = testEnv();
const PASSWORD = 'correct-horse-battery';

let app: FastifyInstance;
let db: Awaited<ReturnType<typeof withDb>>;
let accountId: string;
let agentId: string;
let conversationId: string;
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

async function stageNamed(name: string) {
  const rows = await db.select().from(stages).where(eq(stages.agentId, agentId));
  return rows.find((row) => row.name === name)!;
}

const leadUrl = () => `/api/agents/${agentId}/conversations/${conversationId}/lead`;

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

  app = buildServer(env, db, { graph: fakeGraph() });
  await app.ready();
  jar = await login('owner@example.com');

  const created = await app.inject({
    method: 'POST',
    url: `/api/accounts/${accountId}/agents`,
    cookies: jar,
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
      adHeadline: 'Ремонт под ключ',
    })
    .returning();
  conversationId = conversation!.id;
});

afterEach(async () => {
  await app.close();
});

describe('sumAmounts', () => {
  it('adds without a rounding error', () => {
    expect(sumAmounts(['0.10', '0.20'])).toBe('0.30');
    expect(sumAmounts(['1234567.89', '0.11'])).toBe('1234568.00');
    expect(sumAmounts([])).toBe('0.00');
  });
});

describe('the lead', () => {
  it('starts with no stage and nothing filled in', async () => {
    const res = await app.inject({ url: leadUrl(), cookies: jar });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.contactName).toBe('Айгуль');
    expect(body.stageId).toBeNull();
    expect(body.assignedTo).toBeNull();
    expect(body.adHeadline).toBe('Ремонт под ключ');
    expect(body.values).toEqual([]);
    expect(body.notes).toEqual([]);
    expect(body.orders).toEqual([]);
    expect(body.paidTotal).toBe('0.00');
    expect(body.currency).toBe('KZT');
  });

  it('records who moved the lead and when', async () => {
    const stage = await stageNamed('В диалоге');

    const res = await app.inject({
      method: 'PATCH',
      url: leadUrl(),
      cookies: jar,
      payload: { stageId: stage.id },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().stageId).toBe(stage.id);
    expect(res.json().stageSetBy).toBe('operator');
    expect(new Date(res.json().stageSetAt).getTime()).toBeGreaterThan(Date.now() - 10_000);
  });

  it('lets an operator move a lead to the sale stage without a Kaspi payment', async () => {
    const sale = (await db.select().from(stages).where(eq(stages.agentId, agentId))).find((row) => row.kind === 'success')!;

    const res = await app.inject({
      method: 'PATCH',
      url: leadUrl(),
      cookies: jar,
      payload: { stageId: sale.id },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().stageId).toBe(sale.id);
  });

  it('leaves the timestamp alone when the stage does not change', async () => {
    const stage = await stageNamed('В диалоге');
    const first = await app.inject({
      method: 'PATCH',
      url: leadUrl(),
      cookies: jar,
      payload: { stageId: stage.id },
    });

    const again = await app.inject({
      method: 'PATCH',
      url: leadUrl(),
      cookies: jar,
      payload: { stageId: stage.id },
    });

    expect(again.json().stageSetAt).toBe(first.json().stageSetAt);
  });

  it('clears the stage with null', async () => {
    const stage = await stageNamed('В диалоге');
    await app.inject({
      method: 'PATCH',
      url: leadUrl(),
      cookies: jar,
      payload: { stageId: stage.id },
    });

    const res = await app.inject({
      method: 'PATCH',
      url: leadUrl(),
      cookies: jar,
      payload: { stageId: null },
    });

    expect(res.json().stageId).toBeNull();
  });

  it("refuses a stage from another agent's funnel", async () => {
    const [other] = await db.insert(agents).values({ accountId, name: 'Другая' }).returning();
    const [stage] = await db
      .insert(stages)
      .values({ agentId: other!.id, name: 'Чужая', color: '#fff', kind: 'active', position: 0 })
      .returning();

    const res = await app.inject({
      method: 'PATCH',
      url: leadUrl(),
      cookies: jar,
      payload: { stageId: stage!.id },
    });

    expect(res.statusCode).toBe(404);
  });

  it('assigns to a member of the account and names them', async () => {
    const members = (await app.inject({ url: `/api/agents/${agentId}/members`, cookies: jar })).json();
    const operator = members.find((member: { name: string }) => member.name === 'Оператор');

    const res = await app.inject({
      method: 'PATCH',
      url: leadUrl(),
      cookies: jar,
      payload: { assignedTo: operator.id },
    });

    expect(res.json().assignedTo).toBe(operator.id);
    expect(res.json().assigneeName).toBe('Оператор');
  });

  it('refuses an assignee who is not in the account', async () => {
    // A real person, in a company of their own: a made-up uuid would pass even if the
    // route stopped scoping the lookup to this account.
    const { userId: stranger } = await createAccountWithOwner(db, {
      company: 'Другая компания',
      email: 'stranger@example.com',
      name: 'Чужой',
      initials: 'ЧУ',
      password: PASSWORD,
    });

    const res = await app.inject({
      method: 'PATCH',
      url: leadUrl(),
      cookies: jar,
      payload: { assignedTo: stranger },
    });

    expect(res.statusCode).toBe(404);
  });

  it('leaves the stage stamp alone when only the assignee changes', async () => {
    const stage = await stageNamed('В диалоге');
    const moved = await app.inject({
      method: 'PATCH',
      url: leadUrl(),
      cookies: jar,
      payload: { stageId: stage.id },
    });
    const members = (await app.inject({ url: `/api/agents/${agentId}/members`, cookies: jar })).json();
    const operator = members.find((member: { name: string }) => member.name === 'Оператор');

    const res = await app.inject({
      method: 'PATCH',
      url: leadUrl(),
      cookies: jar,
      payload: { assignedTo: operator.id },
    });

    expect(res.json().assignedTo).toBe(operator.id);
    expect(res.json().stageSetAt).toBe(moved.json().stageSetAt);
    expect(res.json().stageSetBy).toBe(moved.json().stageSetBy);
  });

  it('keeps the assignee when the stage move loses its race', async () => {
    const first = await stageNamed('Новый лид');
    const mine = await stageNamed('В диалоге');
    const theirs = await stageNamed('Квалифицирован');
    await app.inject({
      method: 'PATCH',
      url: leadUrl(),
      cookies: jar,
      payload: { stageId: first.id },
    });
    const members = (await app.inject({ url: `/api/agents/${agentId}/members`, cookies: jar })).json();
    const operator = members.find((member: { name: string }) => member.name === 'Оператор');

    // The same forced race as in funnel-message.test.ts: a second writer holds the row,
    // the request reads the old stage and blocks on its write, the lead is moved out from
    // under it. The move is then rightly lost — somebody else made it — but the assignee
    // this request also carried is a separate answer to a separate question and must land.
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const other = db.transaction(async (tx) => {
      await tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .for('update');
      await held;
      await tx
        .update(conversations)
        .set({ stageId: theirs.id })
        .where(eq(conversations.id, conversationId));
    });

    const blocked = app.inject({
      method: 'PATCH',
      url: leadUrl(),
      cookies: jar,
      payload: { stageId: mine.id, assignedTo: operator.id },
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    release!();
    await other;
    await blocked;

    const lead = (await app.inject({ url: leadUrl(), cookies: jar })).json();
    expect(lead.assignedTo).toBe(operator.id);
    expect(lead.stageId).toBe(theirs.id);
  });

  it('lists the members of the account with their roles', async () => {
    const res = await app.inject({ url: `/api/agents/${agentId}/members`, cookies: jar });

    const body = res.json() as { name: string; role: string }[];
    expect(body).toHaveLength(2);
    expect(body.find((member) => member.name === 'Владелец')?.role).toBe('owner');
    expect(body.find((member) => member.name === 'Оператор')?.role).toBe('member');
  });
});

describe('lead field values', () => {
  it('stores a value and returns it in field order', async () => {
    const city = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/lead-fields`,
      cookies: jar,
      payload: { name: 'Город', kind: 'text' },
    });
    const budget = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/lead-fields`,
      cookies: jar,
      payload: { name: 'Бюджет', kind: 'number' },
    });

    await app.inject({
      method: 'PUT',
      url: `${leadUrl()}/fields/${budget.json().id}`,
      cookies: jar,
      payload: { value: '450000' },
    });
    const res = await app.inject({
      method: 'PUT',
      url: `${leadUrl()}/fields/${city.json().id}`,
      cookies: jar,
      payload: { value: 'Алматы' },
    });

    expect(res.json().values).toEqual([
      { fieldId: city.json().id, value: 'Алматы' },
      { fieldId: budget.json().id, value: '450000' },
    ]);
  });

  it('overwrites rather than duplicating', async () => {
    const field = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/lead-fields`,
      cookies: jar,
      payload: { name: 'Город', kind: 'text' },
    });
    const url = `${leadUrl()}/fields/${field.json().id}`;
    await app.inject({ method: 'PUT', url, cookies: jar, payload: { value: 'Алматы' } });

    const res = await app.inject({ method: 'PUT', url, cookies: jar, payload: { value: 'Астана' } });

    expect(res.json().values).toEqual([{ fieldId: field.json().id, value: 'Астана' }]);
    expect(await db.select().from(leadValues)).toHaveLength(1);
  });

  it('forgets a field that is emptied', async () => {
    const field = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/lead-fields`,
      cookies: jar,
      payload: { name: 'Город', kind: 'text' },
    });
    const url = `${leadUrl()}/fields/${field.json().id}`;
    await app.inject({ method: 'PUT', url, cookies: jar, payload: { value: 'Алматы' } });

    const res = await app.inject({ method: 'PUT', url, cookies: jar, payload: { value: '   ' } });

    expect(res.json().values).toEqual([]);
    expect(await db.select().from(leadValues)).toHaveLength(0);
  });

  it("answers 404 for another agent's field", async () => {
    const [other] = await db.insert(agents).values({ accountId, name: 'Другая' }).returning();
    const [field] = await db
      .insert(leadFields)
      .values({ agentId: other!.id, name: 'Чужое', kind: 'text', position: 0 })
      .returning();

    const res = await app.inject({
      method: 'PUT',
      url: `${leadUrl()}/fields/${field!.id}`,
      cookies: jar,
      payload: { value: 'x' },
    });

    expect(res.statusCode).toBe(404);
    expect(await db.select().from(leadValues)).toHaveLength(0);
  });
});

describe('notes', () => {
  it('records a note with its author', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/conversations/${conversationId}/notes`,
      cookies: jar,
      payload: { body: 'Просил перезвонить в среду' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().notes).toHaveLength(1);
    expect(res.json().notes[0].body).toBe('Просил перезвонить в среду');
    expect(res.json().notes[0].authorName).toBe('Владелец');
  });

  it('refuses an empty note', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/conversations/${conversationId}/notes`,
      cookies: jar,
      payload: { body: '   ' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('keeps a note whose author is gone', async () => {
    await db.insert(notes).values({ conversationId, authorId: null, body: 'Системная строка' });

    const res = await app.inject({ url: leadUrl(), cookies: jar });

    expect(res.json().notes[0].authorName).toBeNull();
  });
});

describe('the lead total', () => {
  it('counts paid orders only', async () => {
    await seedOrders(db, [
      { agentId, conversationId, amount: '150000.50', currency: 'KZT', status: 'paid' },
      { agentId, conversationId, amount: '20000.50', currency: 'KZT', status: 'paid' },
      { agentId, conversationId, amount: '999999', currency: 'KZT', status: 'pending' },
      { agentId, conversationId, amount: '888888', currency: 'KZT', status: 'cancelled' },
    ]);

    const res = await app.inject({ url: leadUrl(), cookies: jar });

    expect(res.json().paidTotal).toBe('170001.00');
    expect(res.json().orders).toHaveLength(4);
  });

  it('leaves an order in another currency out', async () => {
    // Written straight into the table: the order form only ever offers the agent's own
    // currency, and this is the row that proves the sum does not merely assume that.
    await seedOrders(db, [
      { agentId, conversationId, amount: '100000', currency: 'KZT', status: 'paid' },
      { agentId, conversationId, amount: '500', currency: 'USD', status: 'paid' },
    ]);

    const res = await app.inject({ url: leadUrl(), cookies: jar });

    expect(res.json().paidTotal).toBe('100000.00');
    // Still listed: the card shows every order it has, with the currency each was in.
    expect(res.json().orders).toHaveLength(2);
    expect(res.json().currency).toBe('KZT');
  });
});

describe('access', () => {
  it('lets a member read and move a lead', async () => {
    const memberJar = await login('member@example.com');
    const stage = await stageNamed('В диалоге');

    const res = await app.inject({
      method: 'PATCH',
      url: leadUrl(),
      cookies: memberJar,
      payload: { stageId: stage.id },
    });

    expect(res.statusCode).toBe(200);
  });

  it("answers 404 for another agent's conversation", async () => {
    const [other] = await db.insert(agents).values({ accountId, name: 'Другая' }).returning();

    const res = await app.inject({
      url: `/api/agents/${other!.id}/conversations/${conversationId}/lead`,
      cookies: jar,
    });

    expect(res.statusCode).toBe(404);
  });

  it('answers 404 for a conversation id that is not a uuid', async () => {
    const res = await app.inject({
      url: `/api/agents/${agentId}/conversations/не-uuid/lead`,
      cookies: jar,
    });

    expect(res.statusCode).toBe(404);
  });

  it('answers 404 when a writing route is given a conversation id that is not a uuid', async () => {
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/agents/${agentId}/conversations/не-uuid/lead`,
      cookies: jar,
      payload: { stageId: null },
    });
    const noted = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/conversations/не-uuid/notes`,
      cookies: jar,
      payload: { body: 'Заметка' },
    });

    // A non-uuid reaching a uuid column makes Postgres raise, which would answer 500.
    expect(patched.statusCode).toBe(404);
    expect(noted.statusCode).toBe(404);
    expect(await db.select().from(notes)).toHaveLength(0);
  });

  it('answers 404 for a field id that is not a uuid', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `${leadUrl()}/fields/не-uuid`,
      cookies: jar,
      payload: { value: 'Алматы' },
    });

    expect(res.statusCode).toBe(404);
    expect(await db.select().from(leadValues)).toHaveLength(0);
  });
});
