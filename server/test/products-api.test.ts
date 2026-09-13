import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Product } from '@rakurs/contract';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { agents, productPhotos, products } from '../src/db/schema.js';
import { PHOTO_MAX_BYTES, PHOTOS_PER_PRODUCT, sniffImage } from '../src/lib/catalog/products.js';
import { addMember, createAccountWithOwner } from '../src/lib/provision.js';
import { withDb } from './helpers/db.js';
import { testEnv } from './helpers/env.js';
import { fakeGraph } from './helpers/fake-graph.js';

const PASSWORD = 'correct-horse-battery';
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 2)]);

let db: Awaited<ReturnType<typeof withDb>>;
let app: FastifyInstance;
let mediaDir: string;
let agentId: string;
let otherAgentId: string;
let owner: Record<string, string>;
let member: Record<string, string>;

async function login(email: string): Promise<Record<string, string>> {
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: PASSWORD } });
  const cookie = response.cookies[0]!;
  return { [cookie.name]: cookie.value };
}

/** A multipart body written by hand, as `linked-pairing.test.ts` does. */
function multipart(file: { name: string; type: string; bytes: Buffer }, caption?: string) {
  const boundary = '----rakursproducts';
  const head = Buffer.from(
    `--${boundary}\r\n`
      + (caption === undefined ? '' : `Content-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n--${boundary}\r\n`)
      + `Content-Disposition: form-data; name="file"; filename="${file.name}"\r\n`
      + `Content-Type: ${file.type}\r\n\r\n`,
  );
  return {
    payload: Buffer.concat([head, file.bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

const version = async () =>
  (await db.select({ v: agents.configVersion }).from(agents).where(eq(agents.id, agentId)))[0]!.v;

const url = (path = '') => `/api/agents/${agentId}/products${path}`;

async function create(body: Record<string, unknown> = {}): Promise<Product> {
  const response = await app.inject({
    method: 'POST', url: url(), cookies: owner,
    payload: { name: 'Дверь «Гранит»', variants: [{ label: '40 мм', price: 85000 }], ...body },
  });
  expect(response.statusCode).toBe(201);
  return response.json();
}

async function upload(productId: string, file = { name: 'door.jpg', type: 'image/jpeg', bytes: JPEG }, caption?: string) {
  const body = multipart(file, caption);
  return app.inject({ method: 'POST', url: url(`/${productId}/photos`), cookies: owner, ...body });
}

beforeEach(async () => {
  db = await withDb();
  mediaDir = await mkdtemp(join(tmpdir(), 'rakurs-products-'));
  const seeded = await createAccountWithOwner(db, {
    company: 'Двери', email: 'owner@products.test', name: 'Owner', initials: 'OW', password: PASSWORD,
  });
  await addMember(db, {
    company: 'Двери', email: 'member@products.test', name: 'Member', initials: 'MB', password: PASSWORD, role: 'member',
  });
  const [agent] = await db.insert(agents).values({ accountId: seeded.accountId, name: 'Agent' }).returning();
  agentId = agent!.id;
  const other = await createAccountWithOwner(db, {
    company: 'Чужие', email: 'stranger@products.test', name: 'Stranger', initials: 'ST', password: PASSWORD,
  });
  const [foreign] = await db.insert(agents).values({ accountId: other.accountId, name: 'Foreign' }).returning();
  otherAgentId = foreign!.id;
  app = buildServer(testEnv({ MEDIA_DIR: mediaDir }), db, { graph: fakeGraph() });
  await app.ready();
  owner = await login('owner@products.test');
  member = await login('member@products.test');
});

afterEach(async () => {
  await app.close();
  await rm(mediaDir, { recursive: true, force: true });
});

describe('product catalog API', () => {
  it('creates, lists, updates and deletes a product, bumping configVersion on every write', async () => {
    const start = await version();
    const product = await create({ description: 'Металлическая' });
    expect(product).toMatchObject({
      name: 'Дверь «Гранит»', description: 'Металлическая', active: true, position: 0,
      variants: [{ label: '40 мм', price: 85000, position: 0 }], photos: [],
    });
    expect(await version()).toBe(start + 1);

    const second = await create({ name: 'Ручка', variants: [] });
    expect(second.position).toBe(1);

    const patched = await app.inject({
      method: 'PATCH', url: url(`/${product.id}`), cookies: owner, payload: { name: 'Дверь «Базальт»', active: false },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ name: 'Дверь «Базальт»', active: false });
    expect(await version()).toBe(start + 3);

    const variants = await app.inject({
      method: 'PUT', url: url(`/${product.id}/variants`), cookies: owner,
      payload: { variants: [{ label: '40 мм', price: 90000 }, { label: '30 мм', price: 72000 }] },
    });
    expect(variants.statusCode).toBe(200);
    expect((variants.json() as Product).variants.map((v) => [v.label, v.price, v.position]))
      .toEqual([['40 мм', 90000, 0], ['30 мм', 72000, 1]]);
    expect(await version()).toBe(start + 4);

    // The editor's save: fields and the size table in one request, one version.
    const together = await app.inject({
      method: 'PATCH', url: url(`/${product.id}`), cookies: owner,
      payload: { description: 'Стальная', variants: [{ label: '', price: 80000 }] },
    });
    expect(together.json()).toMatchObject({ description: 'Стальная', variants: [{ label: '', price: 80000 }] });
    expect(await version()).toBe(start + 5);

    const list = await app.inject({ method: 'GET', url: url(), cookies: member });
    expect(list.statusCode).toBe(200);
    expect((list.json() as Product[]).map((p) => p.name)).toEqual(['Дверь «Базальт»', 'Ручка']);

    const removed = await app.inject({ method: 'DELETE', url: url(`/${product.id}`), cookies: owner });
    expect(removed.statusCode).toBe(200);
    expect(await version()).toBe(start + 6);
    expect(((await app.inject({ method: 'GET', url: url(), cookies: owner })).json() as Product[])).toHaveLength(1);
  });

  it('lets members read but refuses every write to them', async () => {
    const product = await create();
    const start = await version();
    const attempts = [
      app.inject({ method: 'POST', url: url(), cookies: member, payload: { name: 'X' } }),
      app.inject({ method: 'PATCH', url: url(`/${product.id}`), cookies: member, payload: { name: 'X' } }),
      app.inject({ method: 'DELETE', url: url(`/${product.id}`), cookies: member }),
      app.inject({ method: 'PUT', url: url(`/${product.id}/variants`), cookies: member, payload: { variants: [] } }),
      app.inject({ method: 'POST', url: url(`/${product.id}/photos`), cookies: member, ...multipart({ name: 'a.jpg', type: 'image/jpeg', bytes: JPEG }) }),
    ];
    for (const response of await Promise.all(attempts)) expect(response.statusCode).toBe(403);
    expect(await version()).toBe(start);
  });

  it("answers 404 for another agent's product and for a stranger's agent", async () => {
    const product = await create();
    const foreign = await app.inject({ method: 'GET', url: `/api/agents/${otherAgentId}/products`, cookies: owner });
    expect(foreign.statusCode).toBe(404);
    // A product on the foreign agent, reached through the owner's own agent URL.
    const [otherProduct] = await db.insert(products).values({ agentId: otherAgentId, name: 'Чужая' }).returning();
    const crossed = await app.inject({
      method: 'PATCH', url: url(`/${otherProduct!.id}`), cookies: owner, payload: { name: 'Моя' },
    });
    expect(crossed.statusCode).toBe(404);
    const typo = await app.inject({ method: 'PATCH', url: url('/not-a-uuid'), cookies: owner, payload: { name: 'Моя' } });
    expect(typo.statusCode).toBe(404);
    expect(product.id).toBeDefined();
  });

  it('validates names, prices and variant counts', async () => {
    const bad = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: url(), cookies: owner, payload });
    expect((await bad({ name: '  ' })).statusCode).toBe(400);
    expect((await bad({ name: 'X', variants: [{ label: '', price: -1 }] })).json().message).toBe('Цена должна быть целым числом от 0');
    expect((await bad({ name: 'X', variants: [{ label: '', price: 10.5 }] })).statusCode).toBe(400);
    const many = Array.from({ length: 21 }, () => ({ label: '', price: 1 }));
    expect((await bad({ name: 'X', variants: many })).json().message).toBe('Не больше 20 вариантов у товара');
  });

  it('uploads a photo, serves it to members, captions, reorders and deletes it with its file', async () => {
    const product = await create();
    const start = await version();

    const first = await upload(product.id, { name: 'front.jpg', type: 'image/jpeg', bytes: JPEG }, 'Вид спереди');
    expect(first.statusCode).toBe(201);
    const second = await upload(product.id, { name: 'side.png', type: 'image/png', bytes: PNG });
    const photos = (second.json() as Product).photos;
    expect(photos.map((p) => [p.filename, p.mime, p.caption, p.position])).toEqual([
      ['front.jpg', 'image/jpeg', 'Вид спереди', 0],
      ['side.png', 'image/png', null, 1],
    ]);
    expect(await version()).toBe(start + 2);

    const file = await app.inject({ method: 'GET', url: url(`/${product.id}/photos/${photos[0]!.id}/file`), cookies: member });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('image/jpeg');
    expect(file.rawPayload.equals(JPEG)).toBe(true);

    const captioned = await app.inject({
      method: 'PATCH', url: url(`/${product.id}/photos/${photos[1]!.id}`), cookies: owner, payload: { caption: 'Сбоку' },
    });
    expect((captioned.json() as Product).photos[1]!.caption).toBe('Сбоку');

    const reordered = await app.inject({
      method: 'PUT', url: url(`/${product.id}/photos/order`), cookies: owner,
      payload: { photoIds: [photos[1]!.id, photos[0]!.id] },
    });
    expect((reordered.json() as Product).photos.map((p) => p.id)).toEqual([photos[1]!.id, photos[0]!.id]);
    const partial = await app.inject({
      method: 'PUT', url: url(`/${product.id}/photos/order`), cookies: owner, payload: { photoIds: [photos[1]!.id] },
    });
    expect(partial.statusCode).toBe(409);

    const [row] = await db.select().from(productPhotos).where(eq(productPhotos.id, photos[0]!.id));
    expect(existsSync(join(mediaDir, row!.mediaPath))).toBe(true);
    const removed = await app.inject({ method: 'DELETE', url: url(`/${product.id}/photos/${photos[0]!.id}`), cookies: owner });
    expect(removed.statusCode).toBe(200);
    expect((removed.json() as Product).photos.map((p) => [p.id, p.position])).toEqual([[photos[1]!.id, 0]]);
    expect(existsSync(join(mediaDir, row!.mediaPath))).toBe(false);
    expect(await version()).toBe(start + 5);
  });

  it('refuses a file that is not a JPEG, PNG or WebP whatever it claims to be', async () => {
    const product = await create();
    const fake = await upload(product.id, { name: 'photo.jpg', type: 'image/jpeg', bytes: Buffer.from('%PDF-1.7 not an image') });
    expect(fake.statusCode).toBe(415);
    expect(fake.json().message).toBe('Подойдут только фото JPEG, PNG или WebP.');
    expect(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
  });

  it('refuses a photo over 5 MB', async () => {
    const product = await create();
    const big = Buffer.concat([JPEG, Buffer.alloc(PHOTO_MAX_BYTES, 0)]);
    const response = await upload(product.id, { name: 'big.jpg', type: 'image/jpeg', bytes: big });
    expect(response.statusCode).toBe(413);
    expect(await db.select().from(productPhotos)).toHaveLength(0);
  });

  it('refuses the eleventh photo of a product', async () => {
    const product = await create();
    for (let i = 0; i < PHOTOS_PER_PRODUCT; i += 1) expect((await upload(product.id)).statusCode).toBe(201);
    const over = await upload(product.id);
    expect(over.statusCode).toBe(409);
    expect(await db.select().from(productPhotos)).toHaveLength(PHOTOS_PER_PRODUCT);
  });

  it('removes the files of a deleted product', async () => {
    const product = await create();
    await upload(product.id);
    const [row] = await db.select().from(productPhotos);
    expect(existsSync(join(mediaDir, row!.mediaPath))).toBe(true);
    await app.inject({ method: 'DELETE', url: url(`/${product.id}`), cookies: owner });
    expect(existsSync(join(mediaDir, row!.mediaPath))).toBe(false);
  });
});
