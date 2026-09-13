import type { Product, Promotion } from '@rakurs/contract';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { agents, products, productVariants, promotionItems, promotions } from '../src/db/schema.js';
import { loadEffectivePromotion, settleExpiredPromotions } from '../src/lib/catalog/promotions.js';
import { addMember, createAccountWithOwner } from '../src/lib/provision.js';
import { withDb } from './helpers/db.js';
import { testEnv } from './helpers/env.js';
import { fakeGraph } from './helpers/fake-graph.js';

const PASSWORD = 'correct-horse-battery';

let db: Awaited<ReturnType<typeof withDb>>;
let app: FastifyInstance;
let agentId: string;
let otherAgentId: string;
let owner: Record<string, string>;
let member: Record<string, string>;
let r42: Product;

async function login(email: string): Promise<Record<string, string>> {
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: PASSWORD } });
  const cookie = response.cookies[0]!;
  return { [cookie.name]: cookie.value };
}

const version = async () =>
  (await db.select({ v: agents.configVersion }).from(agents).where(eq(agents.id, agentId)))[0]!.v;

const url = (path = '') => `/api/agents/${agentId}/promotions${path}`;
const variant = (label: string) => r42.variants.find((v) => v.label === label)!;
const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString();

async function create(body: Record<string, unknown> = {}): Promise<Promotion> {
  const response = await app.inject({
    method: 'POST', url: url(), cookies: owner,
    payload: {
      name: '6990',
      items: [{ variantId: variant('40 мм').id, promoPrice: 6990 }, { variantId: variant('30 мм').id, promoPrice: 6990 }],
      ...body,
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json();
}

const post = (path: string, cookies = owner) => app.inject({ method: 'POST', url: url(path), cookies });

beforeEach(async () => {
  db = await withDb();
  const seeded = await createAccountWithOwner(db, {
    company: 'Часы', email: 'owner@promotions.test', name: 'Owner', initials: 'OW', password: PASSWORD,
  });
  await addMember(db, {
    company: 'Часы', email: 'member@promotions.test', name: 'Member', initials: 'MB', password: PASSWORD, role: 'member',
  });
  const [agent] = await db.insert(agents).values({ accountId: seeded.accountId, name: 'Agent' }).returning();
  agentId = agent!.id;
  const other = await createAccountWithOwner(db, {
    company: 'Чужие', email: 'stranger@promotions.test', name: 'Stranger', initials: 'ST', password: PASSWORD,
  });
  const [foreign] = await db.insert(agents).values({ accountId: other.accountId, name: 'Foreign' }).returning();
  otherAgentId = foreign!.id;
  app = buildServer(testEnv(), db, { graph: fakeGraph() });
  await app.ready();
  owner = await login('owner@promotions.test');
  member = await login('member@promotions.test');
  const made = await app.inject({
    method: 'POST', url: `/api/agents/${agentId}/products`, cookies: owner,
    payload: { name: 'Корпус R42', variants: [{ label: '40 мм', price: 9990 }, { label: '30 мм', price: 8990 }] },
  });
  r42 = made.json();
});

afterEach(async () => {
  await app.close();
});

describe('promotions API', () => {
  it('creates, lists, updates and deletes a promotion, bumping configVersion on every write', async () => {
    const start = await version();
    const created = await create({ description: 'Упаковка в подарок', endsAt: inAnHour() });
    expect(created).toMatchObject({
      name: '6990', description: 'Упаковка в подарок', active: false, effective: false, position: 0,
      items: [
        { variantId: variant('40 мм').id, productId: r42.id, productName: 'Корпус R42', variantLabel: '40 мм', regularPrice: 9990, promoPrice: 6990 },
        { variantId: variant('30 мм').id, variantLabel: '30 мм', regularPrice: 8990, promoPrice: 6990 },
      ],
    });
    expect(await version()).toBe(start + 1);

    const updated = await app.inject({
      method: 'PUT', url: url(`/${created.id}`), cookies: owner,
      payload: { name: 'Осень', endsAt: null, items: [{ variantId: variant('30 мм').id, promoPrice: 5990 }] },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ name: 'Осень', description: '', endsAt: null,
      items: [{ variantLabel: '30 мм', promoPrice: 5990 }] });
    expect(await version()).toBe(start + 2);

    const list = await app.inject({ method: 'GET', url: url(), cookies: member });
    expect(list.statusCode).toBe(200);
    expect((list.json() as Promotion[]).map((p) => p.name)).toEqual(['Осень']);

    expect((await app.inject({ method: 'DELETE', url: url(`/${created.id}`), cookies: owner })).statusCode).toBe(200);
    expect(await version()).toBe(start + 3);
    expect(await db.select().from(promotionItems)).toHaveLength(0);
  });

  it('activates one promotion at a time, switching the other off, and bumps on activate and deactivate', async () => {
    const first = await create();
    const second = await create({ name: 'Вторая' });
    const start = await version();

    const on = await post(`/${first.id}/activate`);
    expect(on.statusCode).toBe(200);
    expect(on.json()).toMatchObject({ active: true, effective: true });
    expect(await version()).toBe(start + 1);

    const switched = await post(`/${second.id}/activate`);
    expect(switched.json()).toMatchObject({ active: true });
    const list = (await app.inject({ method: 'GET', url: url(), cookies: owner })).json() as Promotion[];
    expect(list.map((p) => [p.name, p.active])).toEqual([['6990', false], ['Вторая', true]]);
    expect(await version()).toBe(start + 2);

    // Already on: nothing changes, so nothing is bumped.
    await post(`/${second.id}/activate`);
    expect(await version()).toBe(start + 2);

    const off = await post(`/${second.id}/deactivate`);
    expect(off.json()).toMatchObject({ active: false, effective: false });
    expect(await version()).toBe(start + 3);
  });

  it('keeps at most one active promotion per agent in the database itself', async () => {
    await db.insert(promotions).values({ agentId, name: 'A', active: true });
    await expect(db.insert(promotions).values({ agentId, name: 'B', active: true })).rejects.toThrow();
    // Another agent's active promotion and inactive ones are unaffected by the index.
    await db.insert(promotions).values({ agentId: otherAgentId, name: 'C', active: true });
    await db.insert(promotions).values({ agentId, name: 'D', active: false });
  });

  it('switches both concurrent activations through one at a time', async () => {
    const first = await create();
    const second = await create({ name: 'Вторая' });
    const [a, b] = await Promise.all([post(`/${first.id}/activate`), post(`/${second.id}/activate`)]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect(await db.select().from(promotions).where(eq(promotions.active, true))).toHaveLength(1);
  });

  it("refuses a variant of another agent's catalog", async () => {
    const [foreignProduct] = await db.insert(products).values({ agentId: otherAgentId, name: 'Чужой' }).returning();
    const [foreignVariant] = await db.insert(productVariants)
      .values({ productId: foreignProduct!.id, label: '40 мм', price: 100 }).returning();
    const start = await version();
    const response = await app.inject({
      method: 'POST', url: url(), cookies: owner,
      payload: { name: 'Чужая', items: [{ variantId: foreignVariant!.id, promoPrice: 1 }] },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toBe('Вариант товара не найден');
    expect(await db.select().from(promotions)).toHaveLength(0);
    expect(await version()).toBe(start);
  });

  it('validates names, prices, duplicates and the end date', async () => {
    const bad = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: url(), cookies: owner, payload });
    const id = variant('40 мм').id;
    expect((await bad({ name: ' ', items: [] })).json().message).toBe('Укажите название акции');
    expect((await bad({ name: 'X', items: [{ variantId: id, promoPrice: -1 }] })).json().message)
      .toBe('Цена по акции должна быть целым числом от 0');
    expect((await bad({ name: 'X', items: [{ variantId: id, promoPrice: 1 }, { variantId: id, promoPrice: 2 }] })).json().message)
      .toBe('Вариант указан в акции дважды');
    expect((await bad({ name: 'X', items: [], endsAt: 'завтра' })).json().message).toBe('Не удалось разобрать дату окончания');
    expect((await bad({ name: 'X', items: [], endsAt: new Date(Date.now() - 60_000).toISOString() })).json().message)
      .toBe('Дата окончания уже прошла');
  });

  it('refuses to switch on an expired or empty promotion', async () => {
    const empty = await create({ items: [] });
    expect((await post(`/${empty.id}/activate`)).json().message).toBe('В акции нет ни одного товара. Добавьте цены по акции.');
    const created = await create();
    await db.update(promotions).set({ endsAt: new Date(Date.now() - 1000) }).where(eq(promotions.id, created.id));
    const response = await post(`/${created.id}/activate`);
    expect(response.statusCode).toBe(409);
    expect(response.json().message).toBe('Срок акции истёк. Измените дату окончания, чтобы включить её.');
  });

  it('treats an active promotion past its end as not in effect, and switches it off on the next read with a bump', async () => {
    const created = await create();
    await post(`/${created.id}/activate`);
    expect(await loadEffectivePromotion(db, agentId)).not.toBeNull();
    await db.update(promotions).set({ endsAt: new Date(Date.now() - 1000) }).where(eq(promotions.id, created.id));
    // Not in effect before anything switched it off.
    expect(await loadEffectivePromotion(db, agentId)).toBeNull();
    const start = await version();

    const list = await app.inject({ method: 'GET', url: url(), cookies: member });
    expect((list.json() as Promotion[])[0]).toMatchObject({ active: false, effective: false });
    expect(await version()).toBe(start + 1);
    // Settled once: a second read bumps nothing.
    expect(await settleExpiredPromotions(db, agentId)).toBeNull();
    await app.inject({ method: 'GET', url: url(), cookies: member });
    expect(await version()).toBe(start + 1);
  });

  it('keeps promotion prices when the product is saved with the same variants, drops a removed one', async () => {
    const created = await create();
    const saved = await app.inject({
      method: 'PATCH', url: `/api/agents/${agentId}/products/${r42.id}`, cookies: owner,
      payload: { description: 'Сталь', variants: [
        { id: variant('40 мм').id, label: '40 мм', price: 10990 },
        { label: '44 мм', price: 11990 },
      ] },
    });
    expect(saved.statusCode).toBe(200);
    expect((saved.json() as Product).variants.map((v) => v.label)).toEqual(['40 мм', '44 мм']);
    const [after] = (await app.inject({ method: 'GET', url: url(), cookies: owner })).json() as Promotion[];
    expect(after!.id).toBe(created.id);
    expect(after!.items).toEqual([expect.objectContaining({ variantId: variant('40 мм').id, regularPrice: 10990, promoPrice: 6990 })]);
  });

  it('lets members read but refuses every write to them', async () => {
    const created = await create();
    const start = await version();
    const attempts = [
      app.inject({ method: 'POST', url: url(), cookies: member, payload: { name: 'X', items: [] } }),
      app.inject({ method: 'PUT', url: url(`/${created.id}`), cookies: member, payload: { name: 'X', items: [] } }),
      app.inject({ method: 'DELETE', url: url(`/${created.id}`), cookies: member }),
      post(`/${created.id}/activate`, member),
      post(`/${created.id}/deactivate`, member),
    ];
    for (const response of await Promise.all(attempts)) expect(response.statusCode).toBe(403);
    expect(await version()).toBe(start);
    expect((await app.inject({ method: 'GET', url: url(), cookies: member })).statusCode).toBe(200);
  });

  it("answers 404 for another agent's promotion", async () => {
    const [foreign] = await db.insert(promotions).values({ agentId: otherAgentId, name: 'Чужая' }).returning();
    expect((await post(`/${foreign!.id}/activate`)).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/agents/${otherAgentId}/promotions`, cookies: owner })).statusCode).toBe(404);
    expect((await post('/not-a-uuid/activate')).statusCode).toBe(404);
  });
});
