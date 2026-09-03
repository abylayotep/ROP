import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import {
  contacts,
  conversations,
  messages,
  orders,
  stages,
  whatsappNumbers,
} from '../src/db/schema.js';
import { createAccountWithOwner } from '../src/lib/provision.js';
import { toCsv } from '../src/api/board.js';
import { withDb } from './helpers/db.js';
import { testEnv } from './helpers/env.js';
import { fakeGraph } from './helpers/fake-graph.js';

const env = testEnv();
const PASSWORD = 'correct-horse-battery';
const DAY = 24 * 60 * 60 * 1000;

let app: FastifyInstance;
let db: Awaited<ReturnType<typeof withDb>>;
let accountId: string;
let ownerId: string;
let agentId: string;
let numberId: string;
let jar: Record<string, string>;

async function login(email = 'owner@example.com') {
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

/** A conversation with a contact of its own, and the timestamps the views sort by. */
async function seedConversation(
  phone: string,
  name: string | null,
  values: Partial<typeof conversations.$inferInsert> = {},
) {
  const [contact] = await db.insert(contacts).values({ agentId, phone, name }).returning();
  const [conversation] = await db
    .insert(conversations)
    .values({
      agentId,
      contactId: contact!.id,
      whatsappNumberId: numberId,
      lastInboundAt: new Date(Date.now() - 60_000),
      lastMessageAt: new Date(Date.now() - 60_000),
      ...values,
    })
    .returning();
  return conversation!.id;
}

beforeEach(async () => {
  db = await withDb();
  ({ accountId, userId: ownerId } = await createAccountWithOwner(db, {
    company: 'Сафина',
    email: 'owner@example.com',
    name: 'Владелец',
    initials: 'ВЛ',
    password: PASSWORD,
  }));

  app = buildServer(env, db, { graph: fakeGraph() });
  await app.ready();
  jar = await login();

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
  numberId = number!.id;
});

afterEach(async () => {
  await app.close();
});

describe('toCsv', () => {
  it('separates with a semicolon and quotes what would break a cell', () => {
    const csv = toCsv([
      ['Имя', 'Комментарий'],
      ['Айгуль', 'Сказала: «дорого»; подумает'],
      ['Аян', 'Строка\nи ещё строка'],
    ]);

    expect(csv.split('\r\n')[0]).toBe('Имя;Комментарий');
    expect(csv).toContain('"Сказала: «дорого»; подумает"');
    expect(csv).toContain('"Строка\nи ещё строка"');
  });

  it('doubles a quote inside a cell', () => {
    expect(toCsv([['a"b']])).toBe('"a""b"');
  });

  // Formula injection: Excel evaluates a cell that opens with one of these, and it does so
  // after unquoting, so quoting alone is not a defence. The apostrophe makes it text.
  it('defuses a cell that Excel would read as a formula', () => {
    expect(toCsv([['=1+1']])).toBe("'=1+1");
    expect(toCsv([['+7 700']])).toBe("'+7 700");
    expect(toCsv([['-1']])).toBe("'-1");
    expect(toCsv([['@SUM']])).toBe("'@SUM");
    // A leading tab is stripped by Excel before it looks for the formula character.
    expect(toCsv([['\t=1+1']])).toBe("'\t=1+1");
    // An ordinary value is left exactly as it was.
    expect(toCsv([['Айгуль']])).toBe('Айгуль');
  });
});

describe('the board', () => {
  it('has a column per stage, in order, and an unsorted list', async () => {
    await seedConversation('77000000001', 'Айгуль');

    const res = await app.inject({ url: `/api/agents/${agentId}/board`, cookies: jar });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.columns.map((column: { stage: { name: string } }) => column.stage.name)).toEqual([
      'Новый лид',
      'В диалоге',
      'Интерес проявлен',
      'Квалифицирован',
      'Предложение отправлено',
      'Готов к покупке',
      'Счёт отправлен',
      'Продажа',
      'Отказ',
    ]);
    expect(body.currency).toBe('KZT');
    expect(body.unsorted).toHaveLength(1);
    expect(body.columns.every((column: { cards: unknown[] }) => column.cards.length === 0)).toBe(true);
  });

  it('puts a card in its stage with its last line and its paid total', async () => {
    const stage = await stageNamed('Счёт отправлен');
    const conversationId = await seedConversation('77000000002', 'Аян', {
      stageId: stage.id,
      adHeadline: 'Ремонт под ключ',
    });
    await db.insert(messages).values({
      conversationId,
      waMessageId: 'wamid.1',
      direction: 'in',
      author: 'client',
      kind: 'text',
      body: 'Сколько будет стоить?',
      sentAt: new Date(Date.now() - 120_000),
    });
    await db.insert(messages).values({
      conversationId,
      waMessageId: 'wamid.2',
      direction: 'out',
      author: 'operator',
      kind: 'text',
      body: 'Отправил счёт',
      sentAt: new Date(Date.now() - 60_000),
    });
    await db.insert(orders).values([
      { agentId, conversationId, amount: '100000', currency: 'KZT', status: 'paid' },
      { agentId, conversationId, amount: '900000', currency: 'KZT', status: 'pending' },
    ]);

    const res = await app.inject({ url: `/api/agents/${agentId}/board`, cookies: jar });

    const column = res
      .json()
      .columns.find((c: { stage: { id: string } }) => c.stage.id === stage.id);
    expect(column.cards).toHaveLength(1);
    expect(column.cards[0].contactName).toBe('Аян');
    expect(column.cards[0].preview).toBe('Отправил счёт');
    expect(column.cards[0].paidTotal).toBe('100000.00');
    expect(column.cards[0].adHeadline).toBe('Ремонт под ключ');
    expect(column.cards[0].windowOpen).toBe(true);
  });

  it('says when the window has closed', async () => {
    await seedConversation('77000000003', null, {
      lastInboundAt: new Date(Date.now() - DAY - 60_000),
    });

    const res = await app.inject({ url: `/api/agents/${agentId}/board`, cookies: jar });

    expect(res.json().unsorted[0].windowOpen).toBe(false);
  });

  it('sorts cards by the newest message first', async () => {
    await seedConversation('77000000004', 'Старая', {
      lastMessageAt: new Date(Date.now() - 3 * DAY),
    });
    await seedConversation('77000000005', 'Свежая', { lastMessageAt: new Date() });

    const res = await app.inject({ url: `/api/agents/${agentId}/board`, cookies: jar });

    expect(res.json().unsorted.map((card: { contactName: string }) => card.contactName)).toEqual([
      'Свежая',
      'Старая',
    ]);
  });

  it('adds up a total wider than one amount can be', async () => {
    const conversationId = await seedConversation('77000000011', 'Крупная');
    // Two orders at the very top of numeric(14,2). Their sum needs thirteen digits before
    // the point, so casting the total back to numeric(14,2) would raise `numeric field
    // overflow` and fail the whole request rather than this one card.
    await db.insert(orders).values([
      { agentId, conversationId, amount: '999999999999.99', currency: 'KZT', status: 'paid' },
      { agentId, conversationId, amount: '999999999999.99', currency: 'KZT', status: 'paid' },
    ]);

    const res = await app.inject({ url: `/api/agents/${agentId}/board`, cookies: jar });

    expect(res.statusCode).toBe(200);
    expect(res.json().unsorted[0].paidTotal).toBe('1999999999999.98');
  });

  it("shows nothing from another agent", async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/api/accounts/${accountId}/agents`,
      cookies: jar,
      payload: { name: 'Другая' },
    });
    await seedConversation('77000000006', 'Наша');

    const res = await app.inject({
      url: `/api/agents/${created.json().id}/board`,
      cookies: jar,
    });

    expect(res.json().unsorted).toEqual([]);
    // Every column too, not only the unsorted list: a leak into a stage would pass otherwise.
    expect(
      res.json().columns.every((column: { cards: unknown[] }) => column.cards.length === 0),
    ).toBe(true);
  });

  it('answers 404 to someone who is not in the account', async () => {
    await createAccountWithOwner(db, {
      company: 'Чужая',
      email: 'stranger@example.com',
      name: 'Чужой',
      initials: 'ЧУ',
      password: PASSWORD,
    });
    const strangerJar = await login('stranger@example.com');
    await seedConversation('77000000010', 'Наша');

    // 404, never 403: a 403 would confirm this agent exists to someone with no business
    // knowing that. All three routes answer the same way.
    for (const path of ['board', 'customers', 'customers.csv']) {
      const res = await app.inject({
        url: `/api/agents/${agentId}/${path}`,
        cookies: strangerJar,
      });
      expect(res.statusCode).toBe(404);
    }
  });
});

describe('the customers table', () => {
  it('names the stage and counts the orders', async () => {
    const stage = await stageNamed('Продажа');
    const conversationId = await seedConversation('77000000007', 'Айгуль', { stageId: stage.id });
    await db.insert(orders).values([
      { agentId, conversationId, amount: '150000.50', currency: 'KZT', status: 'paid' },
      { agentId, conversationId, amount: '20000.50', currency: 'KZT', status: 'paid' },
      { agentId, conversationId, amount: '1', currency: 'KZT', status: 'cancelled' },
    ]);

    const res = await app.inject({ url: `/api/agents/${agentId}/customers`, cookies: jar });

    expect(res.statusCode).toBe(200);
    const row = res.json()[0];
    expect(row.contactName).toBe('Айгуль');
    expect(row.stageName).toBe('Продажа');
    expect(row.stageKind).toBe('success');
    expect(row.paidTotal).toBe('170001.00');
    // Every order, not only the paid ones: three were recorded against this customer.
    expect(row.orderCount).toBe(3);
    expect(row.firstSeenAt).toBeDefined();
  });

  it('leaves an order in another currency out of the total', async () => {
    const conversationId = await seedConversation('77000000013', 'Айгуль');
    // Written straight into the table: the order form only ever offers the agent's own
    // currency, and this is the row that proves the sum does not merely assume that.
    await db.insert(orders).values([
      { agentId, conversationId, amount: '100000', currency: 'KZT', status: 'paid' },
      { agentId, conversationId, amount: '500', currency: 'USD', status: 'paid' },
    ]);

    const res = await app.inject({ url: `/api/agents/${agentId}/customers`, cookies: jar });

    const row = res.json()[0];
    expect(row.paidTotal).toBe('100000.00');
    // Counted all the same: `orderCount` answers how many orders, not how much money.
    expect(row.orderCount).toBe(2);
  });

  it('lists a customer who is in no stage', async () => {
    await seedConversation('77000000008', null);

    const res = await app.inject({ url: `/api/agents/${agentId}/customers`, cookies: jar });

    expect(res.json()).toHaveLength(1);
    expect(res.json()[0].stageName).toBeNull();
    expect(res.json()[0].paidTotal).toBe('0.00');
    expect(res.json()[0].orderCount).toBe(0);
  });

  it('exports a CSV Excel opens with the Russian intact', async () => {
    const stage = await stageNamed('Продажа');
    const conversationId = await seedConversation('77000000009', 'Айгуль', {
      stageId: stage.id,
      assignedTo: ownerId,
    });
    await db
      .insert(orders)
      .values({ agentId, conversationId, amount: '150000', currency: 'KZT', status: 'paid' });

    const res = await app.inject({ url: `/api/agents/${agentId}/customers.csv`, cookies: jar });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('customers.csv');
    // The byte order mark is what makes Excel read the file as UTF-8 rather than as the
    // system code page, which turns every Russian name into question marks.
    expect(res.body.startsWith('﻿')).toBe(true);

    // CRLF between rows, so splitting on it yields the header and one customer exactly.
    const [header, ...rows] = res.body.slice(1).split('\r\n');
    expect(header).toBe(
      'Имя;Телефон;Стадия;Оплачено;Валюта;Заказов;Первое обращение;Последняя активность;Ответственный',
    );
    expect(rows).toHaveLength(1);

    const cells = rows[0]!.split(';');
    expect(cells[0]).toBe('Айгуль');
    expect(cells[1]).toBe('77000000009');
    expect(cells[2]).toBe('Продажа');
    // A comma, not a dot: the Russian-locale Excel this file is written for reads a
    // dotted number as text, and a column of text cannot be summed.
    expect(cells[3]).toBe('150000,00');
    expect(cells[4]).toBe('KZT');
    expect(cells[5]).toBe('1');
    expect(cells[8]).toBe('Владелец');
  });

  it('defuses a customer who named themselves a formula', async () => {
    // `contactName` is the WhatsApp profile name, which the customer writes. This export is
    // the only place text a stranger controls reaches a file opened in another program.
    await seedConversation('77000000012', '=HYPERLINK("http://evil","Клик")');

    const res = await app.inject({ url: `/api/agents/${agentId}/customers.csv`, cookies: jar });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('"\'=HYPERLINK(""http://evil"",""Клик"")"');
    // The bare formula never appears at the start of a cell.
    expect(res.body).not.toContain('"=HYPERLINK');
  });
});
