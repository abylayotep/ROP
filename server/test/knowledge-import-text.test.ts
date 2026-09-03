import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { kbItems, kbSources } from '../src/db/schema.js';
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

const importText = (payload: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: `/api/agents/${agentId}/knowledge/import/text`,
    cookies: jar,
    payload,
  });

describe('importing pasted text', () => {
  it('creates a source and its items, and answers with both', async () => {
    const res = await importText({
      title: 'Прайс-лист',
      kind: 'product',
      text: 'Дверь входная\nОт 90 000 тенге.\n\nОкно\nОт 40 000 тенге.',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().source.status).toBe('ready');
    expect(res.json().source.itemCount).toBe(2);
    expect(res.json().items).toHaveLength(2);
    expect(res.json().items[0].kind).toBe('product');
    expect(res.json().items[0].sourceTitle).toBe('Прайс-лист');
  });

  it('defaults the kind to other', async () => {
    const res = await importText({ title: 'Заметки', text: 'Работаем с 9 до 18.' });

    expect(res.json().items[0].kind).toBe('other');
  });

  it('refuses text that holds nothing', async () => {
    const res = await importText({ title: 'Пусто', text: '   \n\n  ' });

    expect(res.statusCode).toBe(400);
    expect(await db.select().from(kbSources)).toHaveLength(0);
    expect(await db.select().from(kbItems)).toHaveLength(0);
  });

  it('refuses a paste larger than we will store', async () => {
    const res = await importText({ title: 'Много', text: 'а'.repeat(200_001) });

    expect(res.statusCode).toBe(400);
    expect(await db.select().from(kbSources)).toHaveLength(0);
  });

  it('is refused for a member', async () => {
    const memberJar = await login('member@example.com');

    const res = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/knowledge/import/text`,
      cookies: memberJar,
      payload: { title: 'Прайс', text: 'Дверь\nЦена.' },
    });

    expect(res.statusCode).toBe(403);
  });

  it('imports a paste with more blocks than one statement can carry', async () => {
    // Five bound parameters a row against the 65534-parameter cap is 13106 rows in one
    // INSERT. This paste is well inside PASTE_MAX and past that cap, and used to answer 500.
    const text = Array.from({ length: 14_000 }, (_, i) => `Т${i}`).join('\n\n');
    expect(text.length).toBeLessThan(200_000);

    const res = await importText({ title: 'Каталог', text });

    expect(res.statusCode).toBe(200);
    expect(res.json().source.itemCount).toBe(14_000);
    expect(res.json().items).toHaveLength(14_000);
    expect(await db.select({ id: kbItems.id }).from(kbItems)).toHaveLength(14_000);
  });

  it('answers without the generated search column', async () => {
    const res = await importText({ title: 'Прайс', text: 'Дверь\nОт 90 000 тенге.' });

    // The tsvector is machinery: large, derivable, and — if it ever leaves the database —
    // on its way through this response into stage 5's prompt.
    expect(res.json().items[0]).not.toHaveProperty('search');
    expect(res.payload).not.toContain('search');
  });

it('writes no source when the items cannot be written', async () => {
    // The failure has to come from the item insert itself, so it is induced rather than
    // found: the paste that used to induce it — a NUL byte out of a PDF — is now stripped
    // before it is split, which is the better fix and leaves nothing real to fail on. What
    // the trigger raises does not matter. What matters is that the source row, which is
    // written first, is not left behind claiming items that do not exist.
    await db.execute(sql`
      create function kb_items_refuse() returns trigger language plpgsql as $$
      begin raise exception 'induced failure'; end $$
    `);
    await db.execute(sql`
      create trigger kb_items_refuse before insert on kb_items
      for each row execute function kb_items_refuse()
    `);

    try {
      const res = await importText({ title: 'Прайс', text: 'Дверь\nЦена 90 000.' });

      expect(res.statusCode).toBe(500);
      expect(await db.select().from(kbSources)).toHaveLength(0);
      expect(await db.select({ id: kbItems.id }).from(kbItems)).toHaveLength(0);
    } finally {
      await db.execute(sql`drop trigger kb_items_refuse on kb_items`);
      await db.execute(sql`drop function kb_items_refuse()`);
    }
  });

  it('imports a paste carrying the control characters a PDF leaves behind', async () => {
    const res = await importText({
      title: 'Прайс',
      text: 'Дверь\u0000 входная\nОт 90 000\u0001 тенге.',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().items[0].title).toBe('Дверь входная');
    const [stored] = await db.select({ content: kbItems.content }).from(kbItems);
    expect(stored!.content).toBe('От 90 000 тенге.');
  });

  it('refuses a paste that is nothing but control characters', async () => {
    const res = await importText({ title: 'Мусор', text: '\u0000\u0001\u0000' });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('В тексте нечего сохранить');
    expect(await db.select().from(kbSources)).toHaveLength(0);
    expect(await db.select({ id: kbItems.id }).from(kbItems)).toHaveLength(0);
  });

  it('makes the imported items searchable', async () => {
    await importText({ title: 'Прайс', text: 'Дверь входная\nМеталлическая, Алматы.' });

    const found = await app.inject({
      url: `/api/agents/${agentId}/knowledge/items?q=металлическая`,
      cookies: jar,
    });

    expect(found.json()).toHaveLength(1);
  });
});
