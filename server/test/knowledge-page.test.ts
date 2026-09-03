import { sql } from 'drizzle-orm';
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

/** A page with two sections under one name — a shop that prices doors and windows apart. */
const twoPrices = (windows: string) =>
  [
    '<!doctype html><html><head><title>Сафина</title></head><body>',
    '<h2>Цены</h2><p>Двери 80000.</p>',
    `<h2>Цены</h2><p>${windows}</p>`,
    '</body></html>',
  ].join('');

/** One section, whose body is long enough to be cut in two when the caller wants it to be. */
const priceList = (body: string) =>
  `<!doctype html><html><head><title>Сафина</title></head><body><h2>Прайс</h2><p>${body}</p></body></html>`;

/** A price list of a given length: 400 lines split into two pieces, 700 into three. */
const price = (tenge: string, lines: number) =>
  priceList(`Дверь входная, ${tenge} тенге. `.repeat(lines));

/** Serves one page at one address and imports it, for a test that needs it in place. */
const importAt = (url: string, html: string) => {
  setFetcher(fakeFetcher({ [url]: html }));
  return importPage(url);
};

const importPage = (url: string) =>
  app.inject({
    method: 'POST',
    url: `/api/agents/${agentId}/knowledge/import/page`,
    cookies: jar,
    payload: { url },
  });

const reimport = (sourceId: string) =>
  app.inject({
    method: 'POST',
    url: `/api/agents/${agentId}/knowledge/sources/${sourceId}/reimport`,
    cookies: jar,
  });

/** A correction by a person, which is what flips `edited` and what a reimport must respect. */
const edit = (itemId: string, content: string) =>
  app.inject({
    method: 'PATCH',
    url: `/api/agents/${agentId}/knowledge/items/${itemId}`,
    cookies: jar,
    payload: { content },
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

  it('reads the page again instead of making a second source for the same address', async () => {
    // «Обновить» is the button for this, and nothing stopped the owner using the box
    // instead: a second paste of an address the agent already had used to create a second
    // source and a second copy of every item, and from then on the two drifted apart.
    setFetcher(fakeFetcher({ 'https://safina.kz/': PAGE }));
    const first = await importPage('https://safina.kz/');
    expect(first.json().reimported).toBe(false);
    expect(first.json().keptEdited).toBe(0);

    setFetcher(
      fakeFetcher({
        'https://safina.kz/': PAGE.replace('По городу бесплатно.', 'По городу 1000 тенге.'),
      }),
    );
    const again = await importPage('https://safina.kz/');

    expect(again.statusCode).toBe(200);
    // Said in the response, because the screen cannot tell an update from a first import by
    // which button was pressed — and «Создано 3 записи» would be a lie about both.
    expect(again.json().reimported).toBe(true);
    expect(again.json().source.id).toBe(first.json().source.id);
    expect(await db.select().from(kbSources)).toHaveLength(1);
    const rows = await db.select().from(kbItems);
    expect(rows).toHaveLength(3);
    expect(rows.find((row) => row.title === 'Доставка')?.content).toContain('1000 тенге');
  });

  it('keeps a correction when the same address is pasted again', async () => {
    setFetcher(fakeFetcher({ 'https://safina.kz/': PAGE }));
    const first = await importPage('https://safina.kz/');
    const guarantee = first.json().items.find((i: { title: string }) => i.title === 'Гарантия');
    await edit(guarantee.id, 'Двадцать четыре месяца — уточнили у мастера.');

    const again = await importPage('https://safina.kz/');

    expect(again.json().keptEdited).toBe(1);
    const rows = await db.select().from(kbItems);
    expect(rows.find((row) => row.edited)?.content).toContain('Двадцать четыре месяца');
  });

  it('reuses the failed row when the address finally answers', async () => {
    // One row per address across outcomes, not only within one: only the failure path used
    // to look for an existing row, so a site that was down and then came back left the
    // owner with «не удалось» beside a healthy import of the very same page.
    setFetcher(fakeFetcher({ 'https://safina.kz/': new Error('таймаут') }));
    await importPage('https://safina.kz/');

    setFetcher(fakeFetcher({ 'https://safina.kz/': PAGE }));
    const res = await importPage('https://safina.kz/');

    expect(res.statusCode).toBe(200);
    const rows = await db.select().from(kbSources);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('ready');
    // The reason belongs to an attempt that has been superseded.
    expect(rows[0]?.error).toBeNull();
    expect(await db.select().from(kbItems)).toHaveLength(3);
  });

  it('marks the one row failed when the site goes down again, and keeps its items', async () => {
    setFetcher(fakeFetcher({ 'https://safina.kz/': new Error('таймаут') }));
    await importPage('https://safina.kz/');
    setFetcher(fakeFetcher({ 'https://safina.kz/': PAGE }));
    await importPage('https://safina.kz/');

    setFetcher(fakeFetcher({ 'https://safina.kz/': new Error('таймаут') }));
    await importPage('https://safina.kz/');

    // With two rows for one address and a lookup that named no order, a failure could mark
    // whichever row Postgres handed back first — including the healthy one, whose items were
    // alive and answering while its own row said the import had failed.
    const rows = await db.select().from(kbSources);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('failed');
    expect(await db.select().from(kbItems)).toHaveLength(3);
  });

  it('keeps one row for an address that redirects, across a failure and a success', async () => {
    // Most real addresses redirect: http to https, bare to www. The source used to be known
    // by where the fetch ENDED, which a failed fetch cannot know — so a failure on such an
    // address could not find the row the import had written, and inserted a second one. The
    // next success then rewrote that row's url to the final address, leaving two rows for
    // one page with the items split between them and the younger one lost for good.
    const arrived = { html: PAGE, finalUrl: 'https://www.safina.kz/' };
    setFetcher(fakeFetcher({ 'http://safina.kz/': arrived }));
    const first = await importPage('http://safina.kz/');

    expect(first.statusCode).toBe(200);
    // Stored as typed. The redirect is followed again on every read, which is what a
    // redirect is for — it is not a fact about the page we get to record once.
    expect(first.json().source.url).toBe('http://safina.kz/');

    setFetcher(fakeFetcher({ 'http://safina.kz/': new Error('таймаут') }));
    const down = await importPage('http://safina.kz/');
    expect(down.statusCode).toBe(502);
    expect(await db.select().from(kbSources)).toHaveLength(1);

    setFetcher(fakeFetcher({ 'http://safina.kz/': arrived }));
    const back = await importPage('http://safina.kz/');

    expect(back.json().reimported).toBe(true);
    expect(back.json().source.id).toBe(first.json().source.id);
    const rows = await db.select().from(kbSources);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.url).toBe('http://safina.kz/');
    expect(rows[0]?.status).toBe('ready');
    expect(await db.select().from(kbItems)).toHaveLength(3);
  });

  it('refetches the typed address on «Обновить», not where it last led', async () => {
    setFetcher(fakeFetcher({ 'http://safina.kz/': { html: PAGE, finalUrl: 'https://safina.kz/' } }));
    const first = await importPage('http://safina.kz/');

    // Only the typed address is served, so a reimport that had stored the final URL asks for
    // a page this fetcher does not have and fails.
    setFetcher(fakeFetcher({ 'http://safina.kz/': { html: PAGE, finalUrl: 'https://safina.kz/' } }));
    const res = await reimport(first.json().source.id);

    expect(res.statusCode).toBe(200);
    expect(fetcher.calls).toEqual(['http://safina.kz/']);
  });

  it('treats a trailing slash and a fragment as the same address', async () => {
    // Three spellings of one page were three sources, each with a full duplicate set of
    // items. The query string is deliberately not folded away: `?id=5` is very often the
    // page itself, and merging a catalogue into one source would be the worse mistake.
    setFetcher(fakeFetcher({ 'https://safina.kz/dostavka': PAGE }));

    await importPage('https://safina.kz/dostavka');
    await importPage('https://safina.kz/dostavka/');
    await importPage('https://safina.kz/dostavka#top');

    const rows = await db.select().from(kbSources);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.url).toBe('https://safina.kz/dostavka');
    expect(await db.select().from(kbItems)).toHaveLength(3);
  });

  it('keeps a different query string as a different page', async () => {
    setFetcher(
      fakeFetcher({ 'https://safina.kz/p?id=5': PAGE, 'https://safina.kz/p?id=6': PAGE }),
    );

    await importPage('https://safina.kz/p?id=5');
    await importPage('https://safina.kz/p?id=6');

    expect(await db.select().from(kbSources)).toHaveLength(2);
  });

  it('gives the status column no default, because no path writes a third value', async () => {
    // Both imports are synchronous: the request fetches, splits and writes before it
    // answers. `pending` was a state nothing could ever be in, and a default is how a state
    // like that survives — one insert that forgets the column and the screen has to render
    // it.
    const rows = await db.execute(sql`
      select column_default from information_schema.columns
      where table_name = 'kb_sources' and column_name = 'status'
    `);

    expect([...rows]).toHaveLength(1);
    expect([...rows][0]?.column_default).toBeNull();
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
  it('writes every fresh part and keeps what a person edited', async () => {
    setFetcher(fakeFetcher({ 'https://safina.kz/': PAGE }));
    const first = await importPage('https://safina.kz/');
    const sourceId = first.json().source.id;
    const guarantee = first.json().items.find((i: { title: string }) => i.title === 'Гарантия');

    await edit(guarantee.id, 'Двадцать четыре месяца — уточнили у мастера.');

    setFetcher(
      fakeFetcher({
        'https://safina.kz/': PAGE.replace('По городу бесплатно.', 'По городу 1000 тенге.'),
      }),
    );
    const res = await reimport(sourceId);

    expect(res.statusCode).toBe(200);
    const rows = await db.select().from(kbItems);
    const kept = rows.find((row) => row.title === 'Гарантия' && row.edited);
    expect(kept?.content).toContain('Двадцать четыре месяца');
    expect(rows.find((row) => row.title === 'Доставка')?.content).toContain('1000 тенге');
    // Three fresh parts plus the correction, and the correction's fresh twin is one of the
    // three: no part of the page is dropped because something shares its title. The count
    // is what the owner is told to check, and the response has to answer it rather than
    // leave the screen to work it out from a list that does not say which is which.
    expect(rows).toHaveLength(4);
    expect(res.json().keptEdited).toBe(1);
    expect(res.json().reimported).toBe(true);
  });

  it('keeps both sections when a page has two of the same name', async () => {
    // The case that cost a customer their window prices. Two «Цены» sections import as two
    // items; the owner corrects the first; matching fresh parts by title then deleted the
    // second and discarded BOTH fresh sections, so «Окна 40000» never reached the base and
    // nothing on any screen said it had gone.
    setFetcher(fakeFetcher({ 'https://safina.kz/': twoPrices('Окна 30000.') }));
    const first = await importPage('https://safina.kz/');
    const items = first.json().items as { id: string; title: string; content: string }[];
    expect(items.map((item) => item.title)).toEqual(['Цены', 'Цены']);

    const doors = items.find((item) => item.content.includes('Двери'))!;
    await edit(doors.id, 'Двери 90000 — уточнили у мастера.');

    setFetcher(fakeFetcher({ 'https://safina.kz/': twoPrices('Окна 40000.') }));
    const res = await reimport(first.json().source.id);

    expect(res.statusCode).toBe(200);
    const rows = await db.select().from(kbItems);
    expect(rows.some((row) => row.content.includes('Окна 40000'))).toBe(true);
    expect(rows.some((row) => row.content.includes('Двери 80000'))).toBe(true);
    expect(rows.filter((row) => row.edited).map((row) => row.content)).toEqual([
      'Двери 90000 — уточнили у мастера.',
    ]);
    expect(rows).toHaveLength(3);
    expect(res.json().keptEdited).toBe(1);
  });

  it('says how many corrections to check when a section is renamed', async () => {
    // The correction stays under «Доставка» and the page now calls the section «Доставка по
    // городу». Both are in the base, and one of them may be out of date — which one is a
    // question about the world, so the answer is to name the count and let the owner look,
    // not to guess that the new heading replaces the old one.
    setFetcher(fakeFetcher({ 'https://safina.kz/': PAGE }));
    const first = await importPage('https://safina.kz/');
    const delivery = first.json().items.find((i: { title: string }) => i.title === 'Доставка');

    await edit(delivery.id, 'По городу 500 тенге — договорились со службой.');

    setFetcher(
      fakeFetcher({ 'https://safina.kz/': PAGE.replace('>Доставка<', '>Доставка по городу<') }),
    );
    const res = await reimport(first.json().source.id);

    expect(res.statusCode).toBe(200);
    expect(res.json().keptEdited).toBe(1);
    const rows = await db.select().from(kbItems);
    expect(rows.find((row) => row.title === 'Доставка')?.content).toContain('500 тенге');
    expect(rows.some((row) => row.title === 'Доставка по городу')).toBe(true);
  });

  it('writes every fresh piece when a long section renumbers', async () => {
    // The third scenario, and the one that kills the title filter twice over. A price list
    // long enough to be cut in two imports as «Прайс (1)» and «Прайс (2)»; the owner edits
    // the second piece; the list then grows and is cut into three. Matching by title
    // discarded the fresh «Прайс (2)» — the middle of the current price list — and left the
    // edited fragment of the OLD list sitting where it should have been, wearing its name.
    const first = await importAt('https://safina.kz/', price('80000', 400));
    const pieces = first.json().items as { id: string; title: string }[];
    expect(pieces.map((piece) => piece.title)).toEqual(['Прайс (1)', 'Прайс (2)']);

    await edit(pieces[1]!.id, 'Хвост прайса, выверенный руками.');

    setFetcher(fakeFetcher({ 'https://safina.kz/': price('95000', 700) }));
    const res = await reimport(first.json().source.id);

    expect(res.statusCode).toBe(200);
    expect(res.json().keptEdited).toBe(1);
    const rows = await db.select().from(kbItems);
    expect(rows.map((row) => row.title).sort()).toEqual([
      'Прайс (1)',
      'Прайс (2)',
      'Прайс (2)',
      'Прайс (3)',
    ]);
    // The fresh middle piece is there, under the same title as the kept fragment. Nothing
    // decides between the two here — that is the owner's reading, and `keptEdited` is how
    // they are told there is one to do.
    const fresh = rows.filter((row) => row.title === 'Прайс (2)' && !row.edited);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]?.content).toContain('95000');
    expect(rows.find((row) => row.edited)?.content).toBe('Хвост прайса, выверенный руками.');
  });

  it('counts an edited fragment of a page that no longer splits that way', async () => {
    // The same section shortening instead of growing: «Прайс (2)» survives as a fragment of
    // a version of the page that no longer exists, beside a whole fresh «Прайс». Nothing can
    // stitch it back on, so it is counted — the owner is the only one who can read the two
    // and decide the fragment has had its day.
    const first = await importAt('https://safina.kz/', price('80000', 400));
    const pieces = first.json().items as { id: string; title: string }[];

    await edit(pieces[1]!.id, 'Хвост прайса, выверенный руками.');

    setFetcher(fakeFetcher({ 'https://safina.kz/': priceList('Дверь входная, 95000 тенге.') }));
    const res = await reimport(first.json().source.id);

    expect(res.statusCode).toBe(200);
    expect(res.json().keptEdited).toBe(1);
    const rows = await db.select().from(kbItems);
    expect(rows.map((row) => row.title).sort()).toEqual(['Прайс', 'Прайс (2)']);
    expect(rows.find((row) => row.title === 'Прайс')?.content).toContain('95000');
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
