import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { agents, kbNotes, kbSources } from '../src/db/schema.js';
import { addMember, createAccountWithOwner } from '../src/lib/provision.js';
import { withDb } from './helpers/db.js';
import { testEnv } from './helpers/env.js';
import { fakeFetcher, type FakeFetcher } from './helpers/fake-fetcher.js';
import { fakeGraph } from './helpers/fake-graph.js';

const env = testEnv();
const PASSWORD = 'correct-horse-battery';
/** The one address these tests fetch. What varies between them is what answers at it. */
const PAGE_URL = 'https://safina.kz/';

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

const notes = () => `/api/agents/${agentId}/knowledge/notes`;
const sources = () => `/api/agents/${agentId}/knowledge/sources`;

const PAGE = [
  '<!doctype html><html><head><title>Сафина</title>',
  '<style>.a{color:red}</style><script>alert(1)</script></head><body>',
  '<nav><a href="/">Главная</a><a href="/contacts">Контакты</a></nav>',
  '<h1>Двери</h1><p>Двери и окна в Алматы.</p>',
  '<h2>Доставка</h2><p>По городу бесплатно.</p><p>В Астану 3000 тенге.</p>',
  '<h2>Гарантия</h2><p>Двенадцать месяцев.</p>',
  '<footer>© 2026</footer></body></html>',
].join('');

/** Serves `html` at the one address these tests use, and imports it. */
const importPage = (html: string) => {
  setFetcher(fakeFetcher({ [PAGE_URL]: html }));
  return app.inject({
    method: 'POST',
    url: `/api/agents/${agentId}/knowledge/import/page`,
    cookies: jar,
    payload: { url: PAGE_URL },
  });
};

/** The one source these tests have. */
async function currentSourceId(): Promise<string> {
  const res = await app.inject({ method: 'GET', url: sources(), cookies: jar });
  return res.json()[0].id;
}

const reimportSource = (sourceId: string) =>
  app.inject({
    method: 'POST',
    url: `/api/agents/${agentId}/knowledge/sources/${sourceId}/reimport`,
    cookies: jar,
  });

/** «Обновить» on the sole source these tests keep — re-fetches whatever `fetcher` answers now. */
const refresh = async () => reimportSource(await currentSourceId());

/** A site that has started answering with an error, for the tests about a failed refetch. */
const server = {
  fail(status: number) {
    setFetcher(fakeFetcher({ [PAGE_URL]: new Error(`HTTP ${status}`) }));
  },
};

/** A correction by a person, which is what flips `edited` and what a reimport must respect. */
const edit = (noteId: string, body: string) =>
  app.inject({ method: 'PATCH', url: `${notes()}/${noteId}`, cookies: jar, payload: { body } });

describe('importing a page', () => {
  it('makes one note out of a page', async () => {
    const res = await importPage(PAGE);

    expect(res.statusCode).toBe(200);
    expect(res.json().source.status).toBe('ready');
    expect(res.json().source.url).toBe(PAGE_URL);
    expect(res.json().notes).toHaveLength(1);
    expect(res.json().notes[0]!.path).toBe('С сайта/Двери');
  });

  it('keeps the page headings inside the one note', async () => {
    const res = await importPage(PAGE);

    const opened = await app.inject({
      method: 'GET',
      url: `${notes()}/${res.json().notes[0]!.id}`,
      cookies: jar,
    });
    expect(opened.json().body).toContain('# Двери');
    expect(opened.json().body).toContain('## Доставка');
    expect(opened.json().body).toContain('## Гарантия');
    expect(opened.json().body).not.toContain('Главная');
    expect(opened.json().body).not.toContain('alert(1)');
  });

  it('names the source after the page', async () => {
    const res = await importPage(PAGE);

    expect(res.json().source.title).toBe('Двери');
  });

  it('makes the imported text searchable', async () => {
    await importPage(PAGE);

    const found = await app.inject({
      url: `/api/agents/${agentId}/knowledge/search?q=Астану`,
      cookies: jar,
    });

    expect(found.json()).toHaveLength(1);
  });

  it('refuses a scheme that is not http or https', async () => {
    for (const url of ['file:///etc/passwd', 'data:text/html,<h1>x</h1>', 'ftp://a/b', 'нет']) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/agents/${agentId}/knowledge/import/page`,
        cookies: jar,
        payload: { url },
      });
      expect(res.statusCode, url).toBe(400);
    }
    expect(await db.select().from(kbSources)).toHaveLength(0);
  });

  it('records the failure in Russian and creates no note when the fetch fails', async () => {
    setFetcher(fakeFetcher({ [PAGE_URL]: new Error('getaddrinfo ENOTFOUND safina.kz') }));

    const res = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/knowledge/import/page`,
      cookies: jar,
      payload: { url: PAGE_URL },
    });

    expect(res.statusCode).toBe(502);
    expect(res.json().message).toContain('Не удалось загрузить страницу');
    expect(await db.select().from(kbNotes)).toHaveLength(0);
    const [source] = await db.select().from(kbSources);
    expect(source?.status).toBe('failed');
    expect(source?.error).toBeTruthy();
  });

  it('refuses a page that holds no text', async () => {
    const res = await importPage('<html><body><script>x</script></body></html>');

    expect(res.statusCode).toBe(400);
    expect(await db.select().from(kbNotes)).toHaveLength(0);
    expect(await db.select().from(kbSources)).toHaveLength(0);
  });

  it('keeps one row per address however often the fetch fails', async () => {
    setFetcher(fakeFetcher({ [PAGE_URL]: new Error('таймаут') }));
    const post = () =>
      app.inject({
        method: 'POST',
        url: `/api/agents/${agentId}/knowledge/import/page`,
        cookies: jar,
        payload: { url: PAGE_URL },
      });

    // `importPage` is not used here: it would install a fetcher that answers with `PAGE`,
    // which is exactly the outcome this test is checking does not happen on its own.
    await post();
    await post();
    await post();

    const rows = await db.select().from(kbSources);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('failed');
  });

  it('reads the page again instead of making a second source for the same address', async () => {
    const first = await importPage(PAGE);
    expect(first.json().reimported).toBe(false);
    expect(first.json().keptEdited).toBe(0);

    const again = await importPage(PAGE.replace('По городу бесплатно.', 'По городу 1000 тенге.'));

    expect(again.statusCode).toBe(200);
    expect(again.json().reimported).toBe(true);
    expect(again.json().source.id).toBe(first.json().source.id);
    expect(await db.select().from(kbSources)).toHaveLength(1);
    const rows = await db.select().from(kbNotes);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.body).toContain('1000 тенге');
  });

  it('keeps a correction when the same address is pasted again', async () => {
    const first = await importPage(PAGE);
    await edit(first.json().notes[0]!.id, '# Двери\n\nПравлено вручную.');

    const again = await importPage(PAGE.replace('По городу бесплатно.', 'По городу 1000 тенге.'));

    expect(again.json().keptEdited).toBe(1);
    const rows = await db.select().from(kbNotes);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.body).toContain('Правлено вручную.');
  });

  it('reuses the failed row when the address finally answers', async () => {
    setFetcher(fakeFetcher({ [PAGE_URL]: new Error('таймаут') }));
    await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/knowledge/import/page`,
      cookies: jar,
      payload: { url: PAGE_URL },
    });

    const res = await importPage(PAGE);

    expect(res.statusCode).toBe(200);
    const rows = await db.select().from(kbSources);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('ready');
    expect(rows[0]?.error).toBeNull();
    expect(await db.select().from(kbNotes)).toHaveLength(1);
  });

  it('is refused for a member', async () => {
    const memberJar = await login('member@example.com');

    const res = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/knowledge/import/page`,
      cookies: memberJar,
      payload: { url: PAGE_URL },
    });

    expect(res.statusCode).toBe(403);
  });

  it('treats a trailing slash and a fragment as the same address', async () => {
    // One fetcher, keyed by the address the route normalises every variant down to — see
    // `pageKey`. Three spellings of one page used to be three sources, each with a full
    // duplicate copy of the page's notes.
    setFetcher(fakeFetcher({ 'https://safina.kz/dostavka': PAGE }));
    const post = (url: string) =>
      app.inject({
        method: 'POST',
        url: `/api/agents/${agentId}/knowledge/import/page`,
        cookies: jar,
        payload: { url },
      });

    await post('https://safina.kz/dostavka');
    await post('https://safina.kz/dostavka/');
    await post('https://safina.kz/dostavka#top');

    const rows = await db.select().from(kbSources);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.url).toBe('https://safina.kz/dostavka');
    expect(await db.select().from(kbNotes)).toHaveLength(1);
  });

  it('keeps a different query string as a different page', async () => {
    setFetcher(fakeFetcher({ 'https://safina.kz/p?id=5': PAGE, 'https://safina.kz/p?id=6': PAGE }));

    await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/knowledge/import/page`,
      cookies: jar,
      payload: { url: 'https://safina.kz/p?id=5' },
    });
    await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/knowledge/import/page`,
      cookies: jar,
      payload: { url: 'https://safina.kz/p?id=6' },
    });

    expect(await db.select().from(kbSources)).toHaveLength(2);
    expect(await db.select().from(kbNotes)).toHaveLength(2);
  });
});

describe('refreshing a page', () => {
  it('replaces an untouched note on refresh and keeps an edited one', async () => {
    const first = await importPage('<h1>Двери</h1><p>80 000 ₸.</p>');
    const noteId = first.json().notes[0]!.id;
    await app.inject({
      method: 'PATCH',
      url: `${notes()}/${noteId}`,
      cookies: jar,
      payload: { body: '# Двери\n\n90 000 ₸.' },
    });

    const again = await refresh();

    expect(again.json().keptEdited).toBe(1);
    const kept = await app.inject({ method: 'GET', url: `${notes()}/${noteId}`, cookies: jar });
    expect(kept.json().body).toContain('90 000 ₸.');
  });

  it('leaves the notes alone when the page fails to load', async () => {
    const first = await importPage('<h1>Двери</h1><p>80 000 ₸.</p>');

    server.fail(503);
    const again = await refresh();

    expect(again.json().source.status).toBe('failed');
    const still = await app.inject({
      method: 'GET',
      url: `${notes()}/${first.json().notes[0]!.id}`,
      cookies: jar,
    });
    expect(still.json().body).toContain('80 000 ₸.');
  });

  it('replaces the note outright when nothing was edited', async () => {
    const first = await importPage('<h1>Двери</h1><p>80 000 ₸.</p>');
    const oldNoteId = first.json().notes[0]!.id;

    setFetcher(fakeFetcher({ [PAGE_URL]: '<h1>Двери</h1><p>95 000 ₸.</p>' }));
    const again = await refresh();

    expect(again.json().keptEdited).toBe(0);
    expect(again.json().notes).toHaveLength(1);
    expect(again.json().notes[0]!.id).not.toBe(oldNoteId);
    const rows = await db.select().from(kbNotes);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.body).toContain('95 000 ₸.');
  });

  it('marks the source failed when the page has stopped yielding anything, and keeps the note', async () => {
    const first = await importPage('<h1>Двери</h1><p>80 000 ₸.</p>');

    setFetcher(fakeFetcher({ [PAGE_URL]: '<html><body><script>x</script></body></html>' }));
    const res = await reimportSource(first.json().source.id);

    expect(res.statusCode).toBe(400);
    const [source] = await db.select().from(kbSources);
    expect(source?.status).toBe('failed');
    expect(source?.error).toBeTruthy();
    expect(await db.select().from(kbNotes)).toHaveLength(1);
  });

  it('refuses to reimport a source that was pasted rather than fetched', async () => {
    const pasted = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/knowledge/import/text`,
      cookies: jar,
      payload: { title: 'Прайс', text: 'Дверь\nЦена.' },
    });

    const res = await reimportSource(pasted.json().source.id);

    expect(res.statusCode).toBe(400);
  });

  it("answers 404 for another agent's source", async () => {
    const [other] = await db.insert(agents).values({ accountId, name: 'Другая' }).returning();
    const [source] = await db
      .insert(kbSources)
      .values({ agentId: other!.id, kind: 'page', title: 'x', url: 'https://x/', status: 'ready' })
      .returning();

    const res = await reimportSource(source!.id);

    expect(res.statusCode).toBe(404);
  });

  it('gives the status column no default, because no path writes a third value', async () => {
    // Both imports are synchronous: the request fetches and writes before it answers.
    // `pending` was a state nothing could ever be in, and a default is how a state like that
    // survives — one insert that forgets the column and the screen has to render it.
    const rows = await db.execute(sql`
      select column_default from information_schema.columns
      where table_name = 'kb_sources' and column_name = 'status'
    `);

    expect([...rows]).toHaveLength(1);
    expect([...rows][0]?.column_default).toBeNull();
  });
});

describe('deleting a source', () => {
  it('keeps its note and unlinks it', async () => {
    const first = await importPage(PAGE);

    const res = await app.inject({
      method: 'DELETE',
      url: `${sources()}/${first.json().source.id}`,
      cookies: jar,
    });

    expect(res.statusCode).toBe(200);
    const rows = await db.select().from(kbNotes);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sourceId).toBeNull();
  });
});
