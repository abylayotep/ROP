### Task 2 — the test file

This is step 2 of [task 2](2026-09-03-kb-task-2-items-api.md). It lives in its own document
so that neither crosses the five-hundred-line limit this repository keeps. Copy it verbatim;
the values in it are the task's requirements.

- [ ] **Step 2: Write the failing test**

Create `server/test/knowledge-api.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { agents, kbItems, kbSources } from '../src/db/schema.js';
import { addMember, createAccountWithOwner } from '../src/lib/provision.js';
import { withDb } from './helpers/db.js';
import { testEnv } from './helpers/env.js';
import { fakeGraph } from './helpers/fake-graph.js';

const env = testEnv();
const PASSWORD = 'correct-horse-battery';

let app: FastifyInstance;
let db: Awaited<ReturnType<typeof withDb>>;
let accountId: string;
let agentId: string;
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

const items = () => `/api/agents/${agentId}/knowledge/items`;

async function add(payload: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: items(), cookies: jar, payload });
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
});

afterEach(async () => {
  await app.close();
});

describe('writing knowledge', () => {
  it('stores an item and defaults its kind', async () => {
    const res = await add({ title: 'Доставка', content: 'Возим по Алматы бесплатно.' });

    expect(res.statusCode).toBe(200);
    expect(res.json().kind).toBe('other');
    expect(res.json().edited).toBe(false);
    expect(res.json().sourceId).toBeNull();
    expect(res.json().sourceTitle).toBeNull();
  });

  it('refuses an item with no title or no content', async () => {
    expect((await add({ title: '  ', content: 'что-то' })).statusCode).toBe(400);
    expect((await add({ title: 'Доставка', content: '  ' })).statusCode).toBe(400);
  });

  it('refuses a kind nobody defined', async () => {
    expect((await add({ title: 'Т', content: 'С', kind: 'video' })).statusCode).toBe(400);
  });

  it('refuses a title or a content past the limits', async () => {
    expect((await add({ title: 'т'.repeat(201), content: 'С' })).statusCode).toBe(400);
    expect((await add({ title: 'Т', content: 'с'.repeat(8001) })).statusCode).toBe(400);
  });

  it('marks an item edited when a person changes it', async () => {
    const created = await add({ title: 'Доставка', content: 'Возим по Алматы.' });

    const res = await app.inject({
      method: 'PATCH',
      url: `${items()}/${created.json().id}`,
      cookies: jar,
      payload: { content: 'Возим по Алматы и в Астану.' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().edited).toBe(true);
    expect(res.json().content).toBe('Возим по Алматы и в Астану.');
  });

  it('moves updatedAt when it changes', async () => {
    const created = await add({ title: 'Доставка', content: 'Возим по Алматы.' });
    const before = created.json().updatedAt;

    const res = await app.inject({
      method: 'PATCH',
      url: `${items()}/${created.json().id}`,
      cookies: jar,
      payload: { title: 'Доставка по Казахстану' },
    });

    expect(new Date(res.json().updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(before).getTime(),
    );
  });

  it('deletes an item', async () => {
    const created = await add({ title: 'Доставка', content: 'Возим по Алматы.' });

    const res = await app.inject({
      method: 'DELETE',
      url: `${items()}/${created.json().id}`,
      cookies: jar,
    });

    expect(res.statusCode).toBe(200);
    expect(await db.select().from(kbItems)).toHaveLength(0);
  });

  it('lets a member add and correct an item', async () => {
    const memberJar = await login('member@example.com');

    const created = await app.inject({
      method: 'POST',
      url: items(),
      cookies: memberJar,
      payload: { title: 'Гарантия', content: 'Двенадцать месяцев.' },
    });
    const patched = await app.inject({
      method: 'PATCH',
      url: `${items()}/${created.json().id}`,
      cookies: memberJar,
      payload: { content: 'Двадцать четыре месяца.' },
    });

    expect(created.statusCode).toBe(200);
    expect(patched.statusCode).toBe(200);
  });
});

describe('reading knowledge', () => {
  it('lists the newest first without a query', async () => {
    await add({ title: 'Первый', content: 'Один.' });
    await add({ title: 'Второй', content: 'Два.' });

    const res = await app.inject({ url: items(), cookies: jar });

    expect(res.json().map((row: { title: string }) => row.title)).toEqual(['Второй', 'Первый']);
  });

  it('ranks by relevance with a query and returns only matches', async () => {
    await add({ title: 'Доставка в Астану', content: 'Доставка в Астану два дня.' });
    await add({ title: 'Гарантия', content: 'Действует по всему Казахстану.' });
    await add({ title: 'Оплата', content: 'Картой или наличными.' });

    const res = await app.inject({ url: `${items()}?q=доставка`, cookies: jar });

    const titles = res.json().map((row: { title: string }) => row.title);
    expect(titles[0]).toBe('Доставка в Астану');
    expect(titles).not.toContain('Оплата');
  });

  it('filters by kind', async () => {
    await add({ title: 'Дверь', content: 'От 90 000 тенге.', kind: 'product' });
    await add({ title: 'Как заказать', content: 'Напишите нам.', kind: 'qa' });

    const res = await app.inject({ url: `${items()}?kind=product`, cookies: jar });

    expect(res.json()).toHaveLength(1);
    expect(res.json()[0].kind).toBe('product');
  });

  it('filters by kind and query together', async () => {
    await add({ title: 'Дверь входная', content: 'Металл, Алматы.', kind: 'product' });
    await add({ title: 'Доставка', content: 'По Алматы бесплатно.', kind: 'procedure' });

    const res = await app.inject({ url: `${items()}?kind=product&q=Алматы`, cookies: jar });

    expect(res.json()).toHaveLength(1);
    expect(res.json()[0].title).toBe('Дверь входная');
  });

  it('answers nothing for a query that matches nothing', async () => {
    await add({ title: 'Доставка', content: 'По Алматы.' });

    expect((await app.inject({ url: `${items()}?q=вертолёт`, cookies: jar })).json()).toEqual([]);
  });

  it('names the source an item came from', async () => {
    const [source] = await db
      .insert(kbSources)
      .values({ agentId, kind: 'text', title: 'Прайс-лист', status: 'ready' })
      .returning();
    await db
      .insert(kbItems)
      .values({ agentId, sourceId: source!.id, kind: 'product', title: 'Дверь', content: 'Цена.' });

    const res = await app.inject({ url: items(), cookies: jar });

    expect(res.json()[0].sourceTitle).toBe('Прайс-лист');
  });

  it('lists the sources', async () => {
    await db
      .insert(kbSources)
      .values({ agentId, kind: 'page', title: 'safina.kz', url: 'https://safina.kz', status: 'ready', itemCount: 4 });

    const res = await app.inject({ url: `/api/agents/${agentId}/knowledge/sources`, cookies: jar });

    expect(res.json()).toHaveLength(1);
    expect(res.json()[0].itemCount).toBe(4);
    expect(res.json()[0].url).toBe('https://safina.kz');
  });
});

describe('access', () => {
  it("answers 404 for another agent's item", async () => {
    const [other] = await db.insert(agents).values({ accountId, name: 'Другая' }).returning();
    const [item] = await db
      .insert(kbItems)
      .values({ agentId: other!.id, kind: 'other', title: 'Чужое', content: 'Секрет.' })
      .returning();

    const res = await app.inject({
      method: 'PATCH',
      url: `${items()}/${item!.id}`,
      cookies: jar,
      payload: { title: 'Взлом' },
    });

    expect(res.statusCode).toBe(404);
    const [row] = await db.select().from(kbItems).where(eq(kbItems.id, item!.id));
    expect(row?.title).toBe('Чужое');
  });

  it("never returns another agent's item in a search", async () => {
    const [other] = await db.insert(agents).values({ accountId, name: 'Другая' }).returning();
    await db
      .insert(kbItems)
      .values({ agentId: other!.id, kind: 'other', title: 'Доставка', content: 'По Алматы.' });

    expect((await app.inject({ url: `${items()}?q=Алматы`, cookies: jar })).json()).toEqual([]);
  });

  it('answers 404 for an item id that is not a uuid', async () => {
    const res = await app.inject({ method: 'DELETE', url: `${items()}/не-uuid`, cookies: jar });

    expect(res.statusCode).toBe(404);
  });
});
```

