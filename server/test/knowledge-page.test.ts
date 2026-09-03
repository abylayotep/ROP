import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { agents, kbItems, kbSources } from '../src/db/schema.js';
import { htmlToText } from '../src/lib/knowledge/fetch-page.js';
import { addMember, createAccountWithOwner } from '../src/lib/provision.js';
import { withDb } from './helpers/db.js';
import { testEnv } from './helpers/env.js';
import { fakeFetcher, type FakeFetcher } from './helpers/fake-fetcher.js';
import { fakeGraph } from './helpers/fake-graph.js';

const env = testEnv();
const PASSWORD = 'correct-horse-battery';

let app: FastifyInstance;
let db: Awaited<ReturnType<typeof withDb>>;
let accountId: string;
let agentId: string;
let jar: Record<string, string>;
let fetcher: FakeFetcher;

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
 * Rebuilds the server with a different fetcher, the way `withGraph` does in
 * `conversations.test.ts`.
 *
 * Synchronous, and it does not log in again: the session lives in the database and its
 * cookie is signed with the same secret, so `jar` stays valid across the rebuild — which is
 * what lets a test call this without awaiting it. `inject` readies the instance itself.
 */
function setFetcher(next: FakeFetcher) {
  fetcher = next;
  app = buildServer(env, db, { graph: fakeGraph(), pageFetcher: fetcher });
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

  app = buildServer(env, db, { graph: fakeGraph(), pageFetcher: fakeFetcher({}) });
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

const PAGE = [
  '<!doctype html><html><head><title>Сафина</title>',
  '<style>.a{color:red}</style><script>alert(1)</script></head><body>',
  '<nav><a href="/">Главная</a><a href="/contacts">Контакты</a></nav>',
  '<h1>Сафина</h1><p>Двери и окна в Алматы.</p>',
  '<h2>Доставка</h2><p>По городу бесплатно.</p><p>В Астану 3000 тенге.</p>',
  '<h2>Гарантия</h2><p>Двенадцать месяцев.</p>',
  '<footer>© 2026</footer></body></html>',
].join('');

const importPage = (url: string) =>
  app.inject({
    method: 'POST',
    url: `/api/agents/${agentId}/knowledge/import/page`,
    cookies: jar,
    payload: { url },
  });

describe('htmlToText', () => {
  it('drops scripts, styles, navigation and footers', () => {
    const text = htmlToText(PAGE);

    expect(text).not.toContain('alert(1)');
    expect(text).not.toContain('color:red');
    expect(text).not.toContain('Главная');
    expect(text).not.toContain('© 2026');
    expect(text).toContain('Двери и окна в Алматы.');
  });

  it('turns headings into markdown so the splitter can see them', () => {
    expect(htmlToText(PAGE)).toContain('# Сафина');
    expect(htmlToText(PAGE)).toContain('## Доставка');
  });

  it('keeps paragraphs apart', () => {
    expect(htmlToText(PAGE)).toContain('По городу бесплатно.\nВ Астану 3000 тенге.');
  });

  it('decodes the entities a Russian page actually carries', () => {
    expect(htmlToText('<p>&laquo;Сафина&raquo; &mdash; двери&nbsp;и окна &amp; сервис</p>'))
      .toBe('«Сафина» — двери и окна & сервис');
  });

  it('answers empty for a page with no text', () => {
    expect(htmlToText('<html><body><script>x=1</script></body></html>').trim()).toBe('');
  });
});

describe('importing a page', () => {
  it('creates an item per heading', async () => {
    setFetcher(fakeFetcher({ 'https://safina.kz/': PAGE }));

    const res = await importPage('https://safina.kz/');

    expect(res.statusCode).toBe(200);
    expect(res.json().source.status).toBe('ready');
    expect(res.json().source.url).toBe('https://safina.kz/');
    expect(res.json().items.map((i: { title: string }) => i.title)).toEqual([
      'Сафина',
      'Доставка',
      'Гарантия',
    ]);
  });

  it('names the source after the page', async () => {
    setFetcher(fakeFetcher({ 'https://safina.kz/': PAGE }));

    const res = await importPage('https://safina.kz/');

    expect(res.json().source.title).toContain('safina.kz');
  });

  it('makes the imported text searchable', async () => {
    setFetcher(fakeFetcher({ 'https://safina.kz/': PAGE }));
    await importPage('https://safina.kz/');

    const found = await app.inject({
      url: `/api/agents/${agentId}/knowledge/items?q=Астану`,
      cookies: jar,
    });

    expect(found.json()).toHaveLength(1);
    expect(found.json()[0].title).toBe('Доставка');
  });

  it('refuses a scheme that is not http or https', async () => {
    for (const url of ['file:///etc/passwd', 'data:text/html,<h1>x</h1>', 'ftp://a/b', 'нет']) {
      const res = await importPage(url);
      expect(res.statusCode, url).toBe(400);
    }
    expect(await db.select().from(kbSources)).toHaveLength(0);
  });

  it('records the failure in Russian and creates no items when the fetch fails', async () => {
    setFetcher(fakeFetcher({ 'https://safina.kz/': new Error('getaddrinfo ENOTFOUND safina.kz') }));

    const res = await importPage('https://safina.kz/');

    expect(res.statusCode).toBe(502);
    expect(res.json().message).toContain('Не удалось загрузить страницу');
    expect(await db.select().from(kbItems)).toHaveLength(0);
    // The attempt is kept, with its reason, so the owner can see what happened.
    const [source] = await db.select().from(kbSources);
    expect(source?.status).toBe('failed');
    expect(source?.error).toBeTruthy();
  });

  it('refuses a page that holds no text', async () => {
    setFetcher(fakeFetcher({ 'https://safina.kz/': '<html><body><script>x</script></body></html>' }));

    const res = await importPage('https://safina.kz/');

    expect(res.statusCode).toBe(400);
    expect(await db.select().from(kbItems)).toHaveLength(0);
    // Nothing at all is written: a source with no items is a row that claims an import
    // happened and has nothing to show for it.
    expect(await db.select().from(kbSources)).toHaveLength(0);
  });

  it('keeps one row per address however often the fetch fails', async () => {
    setFetcher(fakeFetcher({ 'https://safina.kz/': new Error('таймаут') }));

    await importPage('https://safina.kz/');
    await importPage('https://safina.kz/');
    await importPage('https://safina.kz/');

    // The row is the standing answer to «what happened with this address», not a diary of
    // attempts: an owner whose site is down presses the button again, and ten identical rows
    // would bury the imports that worked.
    const rows = await db.select().from(kbSources);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('failed');
    expect(rows[0]?.error).toBeTruthy();
  });

  it('is refused for a member', async () => {
    setFetcher(fakeFetcher({ 'https://safina.kz/': PAGE }));
    const memberJar = await login('member@example.com');

    const res = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/knowledge/import/page`,
      cookies: memberJar,
      payload: { url: 'https://safina.kz/' },
    });

    expect(res.statusCode).toBe(403);
  });
});

describe('reimporting', () => {
  it('replaces what it made and keeps what a person edited', async () => {
    setFetcher(fakeFetcher({ 'https://safina.kz/': PAGE }));
    const first = await importPage('https://safina.kz/');
    const sourceId = first.json().source.id;
    const guarantee = first.json().items.find((i: { title: string }) => i.title === 'Гарантия');

    await app.inject({
      method: 'PATCH',
      url: `/api/agents/${agentId}/knowledge/items/${guarantee.id}`,
      cookies: jar,
      payload: { content: 'Двадцать четыре месяца — уточнили у мастера.' },
    });

    setFetcher(
      fakeFetcher({
        'https://safina.kz/': PAGE.replace('По городу бесплатно.', 'По городу 1000 тенге.'),
      }),
    );
    const res = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/knowledge/sources/${sourceId}/reimport`,
      cookies: jar,
    });

    expect(res.statusCode).toBe(200);
    const rows = await db.select().from(kbItems);
    const kept = rows.find((row) => row.title === 'Гарантия' && row.edited);
    expect(kept?.content).toContain('Двадцать четыре месяца');
    expect(rows.filter((row) => row.title === 'Гарантия')).toHaveLength(1);
    expect(rows.find((row) => row.title === 'Доставка')?.content).toContain('1000 тенге');
  });

  it('leaves the old items alone when the refetch fails', async () => {
    setFetcher(fakeFetcher({ 'https://safina.kz/': PAGE }));
    const first = await importPage('https://safina.kz/');
    const before = await db.select().from(kbItems);

    setFetcher(fakeFetcher({ 'https://safina.kz/': new Error('таймаут') }));
    const res = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/knowledge/sources/${first.json().source.id}/reimport`,
      cookies: jar,
    });

    expect(res.statusCode).toBe(502);
    // The same rows, not merely the same number of them: deleting three and writing three
    // others would satisfy a count and would still have thrown away the corrections.
    const after = await db.select().from(kbItems);
    expect(after.map((row) => row.id).sort()).toEqual(before.map((row) => row.id).sort());
    expect(after.map((row) => row.content).sort()).toEqual(
      before.map((row) => row.content).sort(),
    );
    // The source says what happened, so the owner can see the site is not answering.
    const [source] = await db.select().from(kbSources);
    expect(source?.status).toBe('failed');
    expect(source?.error).toBeTruthy();
  });

  it('marks the source failed when the page has stopped yielding anything', async () => {
    setFetcher(fakeFetcher({ 'https://safina.kz/': PAGE }));
    const first = await importPage('https://safina.kz/');
    const sourceId = first.json().source.id;

    setFetcher(
      fakeFetcher({ 'https://safina.kz/': '<html><body><script>x</script></body></html>' }),
    );
    const res = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/knowledge/sources/${sourceId}/reimport`,
      cookies: jar,
    });

    expect(res.statusCode).toBe(400);
    // Leaving it `ready` with the previous itemCount would have the source claim a success
    // that did not happen, and the owner would never learn the page had gone empty.
    const [source] = await db.select().from(kbSources);
    expect(source?.status).toBe('failed');
    expect(source?.error).toBeTruthy();
    // The items stay: they are still the best answer we have.
    expect(await db.select().from(kbItems)).toHaveLength(3);
  });

  it('refuses to reimport a source that was pasted rather than fetched', async () => {
    const pasted = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/knowledge/import/text`,
      cookies: jar,
      payload: { title: 'Прайс', text: 'Дверь\nЦена.' },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/knowledge/sources/${pasted.json().source.id}/reimport`,
      cookies: jar,
    });

    expect(res.statusCode).toBe(400);
  });

  it("answers 404 for another agent's source", async () => {
    const [other] = await db.insert(agents).values({ accountId, name: 'Другая' }).returning();
    const [source] = await db
      .insert(kbSources)
      .values({ agentId: other!.id, kind: 'page', title: 'x', url: 'https://x/', status: 'ready' })
      .returning();

    const res = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/knowledge/sources/${source!.id}/reimport`,
      cookies: jar,
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('deleting a source', () => {
  it('keeps its items and unlinks them', async () => {
    setFetcher(fakeFetcher({ 'https://safina.kz/': PAGE }));
    const first = await importPage('https://safina.kz/');

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/agents/${agentId}/knowledge/sources/${first.json().source.id}`,
      cookies: jar,
    });

    expect(res.statusCode).toBe(200);
    const rows = await db.select().from(kbItems);
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.sourceId === null)).toBe(true);
  });
});
