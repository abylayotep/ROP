### Task 4: Importing a web page

**Files:**
- Create: `server/src/lib/knowledge/fetch-page.ts`
- Create: `server/test/helpers/fake-fetcher.ts`
- Modify: `server/src/api/knowledge.ts` (two routes)
- Modify: `server/src/api/server.ts` (inject the fetcher)
- Create: `server/test/knowledge-page.test.ts`

**Interfaces:**
- Consumes: `splitByHeadings` from task 3, `storeImport` from task 3's route file, `kbSources`, `kbItems`.
- Produces:
  - `interface PageFetcher { fetch(url: string): Promise<{ html: string; finalUrl: string }> }` and `createPageFetcher()` from `server/src/lib/knowledge/fetch-page.ts`
  - `htmlToText(html)` from the same module
  - `POST /api/agents/:agentId/knowledge/import/page` → `KbImport`, owner-only
  - `POST /api/agents/:agentId/knowledge/sources/:sourceId/reimport` → `KbImport`, owner-only
  - `DELETE /api/agents/:agentId/knowledge/sources/:sourceId` → `{ ok: true }`, owner-only
- `ServerDeps` in `server/src/api/server.ts` gains `pageFetcher?`, the same shape `graph?` already has.

**Context.** The other thing a seller can hand over in a minute: the address of their own site. The server fetches one page, strips it to text, and splits it on headings.

**This is the only outbound HTTP on this stage, and the URL comes from a person.** Every guard below exists because of that, and none of them is optional:

- the scheme must be `http` or `https` — `file:`, `data:` and `gopher:` are not addresses of a customer's website;
- the response must be HTML — a 500 MB video answers a GET as happily as a page does;
- what we read is capped, and the cap is enforced while reading, not after — a server that streams forever would otherwise fill this process's memory;
- there is a deadline, the same one the Graph client uses;
- redirects are followed by `fetch` itself, and the URL we store is the one we ended at, because that is the page the text came from.

**Reimport.** It fetches again and replaces the items this source produced — except the ones a person edited, which stay. That is what `edited` is for.

- [ ] **Step 1: Write the failing test**

Create `server/test/helpers/fake-fetcher.ts`:

```ts
import type { PageFetcher } from '../../src/lib/knowledge/fetch-page.js';

export interface FakeFetcher extends PageFetcher {
  /** Every URL asked for, in order. */
  calls: string[];
}

/**
 * A fetcher that answers from a map and records what it was asked.
 *
 * `pages` maps a URL to its HTML; anything else, or a value that is an Error, is thrown.
 */
export function fakeFetcher(pages: Record<string, string | Error>): FakeFetcher {
  const calls: string[] = [];
  return {
    calls,
    async fetch(url: string) {
      calls.push(url);
      const answer = pages[url];
      if (answer === undefined) throw new Error(`нет страницы для ${url}`);
      if (answer instanceof Error) throw answer;
      return { html: answer, finalUrl: url };
    },
  };
}
```

Create `server/test/knowledge-page.test.ts`. Build it on the same fixture as
`server/test/knowledge-api.test.ts` — copy that file's `beforeEach`, `afterEach` and `login`
helper, but build the server with both fakes:
`buildServer(env, db, { graph: fakeGraph(), pageFetcher: fetcher })`, where `fetcher` is a
`let` a helper can replace the way `withGraph` does in `server/test/conversations.test.ts`.
Then:

```ts
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
    expect(await db.select().from(kbItems)).toHaveLength(before.length);
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
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm --prefix server test -- knowledge-page
```

- [ ] **Step 3: Write the fetcher**

Create `server/src/lib/knowledge/fetch-page.ts`. Follow `server/src/lib/whatsapp/graph.ts`
for the shape — an interface, a `create…` returning the real one, and every failure a typed
error with a Russian message.

```ts
/** A page, as fetched. `finalUrl` is where the redirects ended, which is the page we read. */
export interface FetchedPage {
  html: string;
  finalUrl: string;
}

export interface PageFetcher {
  fetch(url: string): Promise<FetchedPage>;
}

/** The same deadline the Graph client takes: a page is on an owner's request path. */
const TIMEOUT_MS = 15_000;
/** Enforced while reading, not after: a server that streams forever must not fill memory. */
const MAX_BYTES = 2_000_000;
```

`createPageFetcher()` returns a `PageFetcher` whose `fetch`:
- throws a `PageError` with a Russian message when the URL does not parse, or its protocol is
  not `http:` or `https:`;
- calls `fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'follow' })`;
- throws when the status is not ok, naming the status;
- throws when `content-type` does not contain `text/html` or `application/xhtml+xml`;
- reads the body through its reader, counting bytes, and throws when the count passes
  `MAX_BYTES` — do not read it whole and check the length afterwards;
- decodes as UTF-8 and returns `{ html, finalUrl: response.url }`.

Export `class PageError extends Error` carrying the Russian message, so the route can tell
a bad page from a bug.

Then `htmlToText(html)`, in the same module. No dependency: this repository has kept its
dependency list to eight packages and an HTML parser for one screen is not the place to
break that. Written as a sequence of replacements over the source, in this order:

1. remove `<script>`, `<style>`, `<noscript>`, `<svg>`, `<head>`, `<nav>`, `<header>`,
   `<footer>`, `<aside>`, `<form>` and everything inside them;
2. turn `<h1>`…`<h6>` into a line of `#` repeated to the level, a space, and the text;
3. turn `<br>`, `</p>`, `</div>`, `</li>`, `</tr>` into a newline, and `<li>` into `- `;
4. remove every remaining tag;
5. decode the entities a Russian page actually carries — at least `&nbsp;` `&amp;` `&lt;`
   `&gt;` `&quot;` `&#39;` `&laquo;` `&raquo;` `&mdash;` `&ndash;` `&hellip;` — plus the
   numeric forms `&#\d+;` and `&#x[0-9a-f]+;`;
6. collapse runs of spaces and tabs, trim each line, and collapse three or more newlines
   into two.

`&amp;` must be decoded last, or `&amp;lt;` becomes `<`.

- [ ] **Step 4: Inject the fetcher**

In `server/src/api/server.ts`, add `pageFetcher?: PageFetcher` to `ServerDeps` with the same
comment style `graph?` has, default it to `createPageFetcher()`, and pass it to
`registerKnowledgeRoutes(app, db, guard, pageFetcher)`.

- [ ] **Step 5: Write the three routes**

In `server/src/api/knowledge.ts`:

- `POST …/import/page` — parse `{ url }`, fetch, `htmlToText`, `splitByHeadings`, and
  `storeImport` with `kind: 'page'`, `title` set to the page's `<title>` when it has one and
  its hostname and path otherwise, `url` set to the fetcher's `finalUrl`, and every item's
  kind `other`. A `PageError` is answered `502` with its own message, AFTER writing a
  `failed` source carrying the reason — the owner needs to see the attempt. A page whose
  text splits into nothing is `400` and writes no source.
- `POST …/sources/:sourceId/reimport` — 404 unless the source belongs to this agent, 400
  unless its kind is `page` and it has a URL. Fetch first; only once that succeeds, in one
  transaction, delete this source's items where `edited` is false and insert the new parts,
  skipping any whose title matches an item that was kept. Update `itemCount` and
  `importedAt`. A failed fetch changes nothing but the source's `status` and `error`.
- `DELETE …/sources/:sourceId` — delete the source. Its items survive with a null
  `sourceId`, which the schema already arranges; say so in a comment rather than deleting
  them, because those are the corrections someone made.

All three are owner-only.

- [ ] **Step 6: Run the tests**

```bash
npm --prefix server test
npm --prefix server run typecheck
npm --prefix rakurs run typecheck
```

- [ ] **Step 7: Commit**

```bash
git add server
git commit -m "Import a web page into the knowledge base"
```
