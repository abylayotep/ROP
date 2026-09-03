### Task 7 — the test file

This is step 2 of [task 7](2026-09-03-orders-task-7-board-api.md). It lives in its own
document so that neither crosses the five-hundred-line limit this repository keeps. Copy it
verbatim; the values in it are the task's requirements.

- [ ] **Step 2: Write the failing test**

Create `server/test/board-api.test.ts`:

```ts
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
let agentId: string;
let numberId: string;
let jar: Record<string, string>;

async function login() {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'owner@example.com', password: PASSWORD },
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
  ({ accountId } = await createAccountWithOwner(db, {
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
    const conversationId = await seedConversation('77000000009', 'Айгуль', { stageId: stage.id });
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
    expect(res.body).toContain('Айгуль');
    expect(res.body).toContain('Продажа');
    expect(res.body).toContain('150000.00');
  });
});
```

