import type { KbImport, KbItem, KbSource } from '@rakurs/contract';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { kbItems, kbSources } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import {
  PAGE_REFUSED,
  PageError,
  htmlToText,
  pageTitle,
  type FetchedPage,
  type PageFetcher,
} from '../lib/knowledge/fetch-page.js';
import { kbItemColumns, searchKnowledge, type KbRow } from '../lib/knowledge/search.js';
// pleep's own limits, and they are the right shape: a fact, not an essay. They live beside
// the splitter because that is the code that has to cut to fit them; a second copy here
// would be one edit away from letting the splitter produce what this route rejects.
import {
  CONTENT_MAX,
  TITLE_MAX,
  splitBlocks,
  splitByHeadings,
  type SplitPart,
} from '../lib/knowledge/split.js';
import { isUuid } from '../lib/uuid.js';
import { requireAgent } from './require-agent.js';

const KINDS = ['product', 'qa', 'procedure', 'contact', 'other'] as const;

/** A paste bigger than this is a file, not a note, and files are not this stage. */
const PASTE_MAX = 200_000;
/**
 * How many items go into one INSERT.
 *
 * A statement carries at most 65534 bound parameters and each item row spends five, so one
 * statement holds 13106 rows. A paste of eighty thousand characters — comfortably inside
 * `PASTE_MAX` — split into twenty thousand one-line blocks is past that, and the owner got
 * «Внутренняя ошибка сервера» for a price list the product had promised to accept. A
 * thousand a statement is far under the cap with room for the row to grow columns, and the
 * chunks run inside the import's transaction, so it is still all of the items or none.
 */
const INSERT_CHUNK = 1000;
/** A search nobody scrolls past. Stage 5 asks for far fewer. */
const SEARCH_LIMIT = 20;
/**
 * The browse list is capped separately, and higher.
 *
 * Twenty is right for a search, where the ranker has put the answer near the top; browsing
 * the store is the other thing this route does, and cutting it at twenty would hide most of
 * what a site import produced. Unbounded is not the alternative: an import yields dozens of
 * chunks per page, and `SELECT *` over all of them is a response that grows with the
 * customer's website. A hundred is a screen's worth of scrolling, and the search box — the
 * same route with `q` — is how the rest is reached until the screen paginates.
 */
const LIST_LIMIT = 100;

const createItem = z.object({
  kind: z.enum(KINDS).default('other'),
  title: z.string().trim().min(1).max(TITLE_MAX),
  content: z.string().trim().min(1).max(CONTENT_MAX),
});

const patchItem = z.object({
  kind: z.enum(KINDS).optional(),
  title: z.string().trim().min(1).max(TITLE_MAX).optional(),
  content: z.string().trim().min(1).max(CONTENT_MAX).optional(),
});

const listQuery = z.object({
  kind: z.enum(KINDS).optional(),
  q: z.string().optional(),
});

/**
 * Long enough for the query string of a real catalogue page and far short of anything a
 * person typed. An address is checked properly by `URL` below; this only keeps a megabyte of
 * paste out of the parser.
 */
const URL_MAX = 2048;

const importPage = z.object({
  url: z.string().trim().min(1).max(URL_MAX),
});

const importText = z.object({
  title: z.string().trim().min(1).max(TITLE_MAX),
  kind: z.enum(KINDS).default('other'),
  text: z.string().max(PASTE_MAX),
});

/**
 * The message for the field that actually failed.
 *
 * One message for the whole body would answer an unknown `kind` by talking about the length
 * of a title the sender got right, and would say the same thing again for a body that is not
 * an object at all. The reader has to be told which of the three it was.
 */
function knowledgeError(
  issue: { code: string; path: readonly PropertyKey[] } | undefined,
): ApiError {
  const tooBig = issue?.code === 'too_big';
  switch (issue?.path[0]) {
    case 'kind':
      return new ApiError(400, `Неизвестный тип записи. Возможные: ${KINDS.join(', ')}`);
    case 'title':
      return tooBig
        ? new ApiError(400, `Заголовок длиннее ${TITLE_MAX} символов`)
        : new ApiError(400, 'Укажите заголовок');
    case 'content':
      return tooBig
        ? new ApiError(400, `Текст длиннее ${CONTENT_MAX} символов`)
        : new ApiError(400, 'Укажите текст записи');
    // The pasted body of an import. It has its own limit — a paste is allowed to be far
    // longer than one item, because the splitter is about to cut it into several — and it
    // branches for the same reason the two above do: a body with no `text` at all told the
    // sender its text was too long, which is precisely the confusion this helper exists for.
    case 'text':
      return tooBig
        ? new ApiError(400, `Текст длиннее ${PASTE_MAX} символов`)
        : new ApiError(400, 'Вставьте текст для импорта');
    case 'url':
      return tooBig
        ? new ApiError(400, `Адрес длиннее ${URL_MAX} символов`)
        : new ApiError(400, 'Укажите адрес страницы');
    default:
      return new ApiError(400, 'Не удалось разобрать запись');
  }
}

export const toKbItem = (row: KbRow, sourceTitle: string | null): KbItem => ({
  id: row.id,
  kind: row.kind as KbItem['kind'],
  title: row.title,
  content: row.content,
  edited: row.edited,
  sourceId: row.sourceId,
  sourceTitle,
  updatedAt: row.updatedAt.toISOString(),
});

const toKbSource = (row: typeof kbSources.$inferSelect): KbSource => ({
  id: row.id,
  kind: row.kind as KbSource['kind'],
  title: row.title,
  url: row.url,
  status: row.status as KbSource['status'],
  error: row.error,
  itemCount: row.itemCount,
  createdAt: row.createdAt.toISOString(),
});

/**
 * The address the owner typed, refused before anything leaves this process.
 *
 * `file:`, `data:` and `gopher:` are not addresses of a customer's website — `file:` would
 * have this server read its own disk and hand the result back over the API — so the check is
 * an allow list and it happens here, in front of the fetcher, rather than only inside it.
 * Here, because a refusal at this point has written nothing: the failed-source row below is
 * for an address that was worth trying, and a typo is not.
 */
function targetUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ApiError(400, 'Это не похоже на адрес страницы');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ApiError(400, 'Адрес должен начинаться с http:// или https://');
  }
  return url;
}

/**
 * What really happened, for `app.log` and nowhere else.
 *
 * The owner is shown `PAGE_REFUSED` and only that, however the fetch failed — see the note
 * on it in `fetch-page.ts`. A message naming the status, the content type or the resolver's
 * complaint would answer «what is listening on this host and port» for whoever typed the
 * address, and the address guard exists precisely because that question is not theirs to ask
 * of the client's own network. This is the other half of that: the detail is kept, in the
 * log, where the people who operate this can read it.
 */
function failureDetail(error: unknown): string {
  if (error instanceof PageError) return error.detail;
  return error instanceof Error ? error.message : String(error);
}

/** A page whose text splits into nothing. The owner's to fix, so it says what happened. */
const NOTHING_TO_SAVE = 'На странице нечего сохранить';

/** The transaction handle, so the insert below can be shared by both imports. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export function registerKnowledgeRoutes(
  app: FastifyInstance,
  db: Db,
  guard: preHandlerHookHandler,
  pageFetcher: PageFetcher,
): void {
  // Any member: an operator who watches the agent give a wrong answer is the fastest way
  // it gets corrected, and a lock would put a day between noticing and fixing.
  const anyMember = requireAgent(db);
  // Importing is not correcting: it writes a batch nobody has read yet, and reimporting or
  // deleting the source takes the batch away again. That is the owner's decision.
  const ownerOnly = requireAgent(db, { role: 'owner' });

  /** The titles of the sources these items came from, in one query rather than per row. */
  async function sourceTitles(agentId: string): Promise<Map<string, string>> {
    const rows = await db
      .select({ id: kbSources.id, title: kbSources.title })
      .from(kbSources)
      .where(eq(kbSources.agentId, agentId));
    return new Map(rows.map((row) => [row.id, row.title]));
  }

  async function loadItem(agentId: string, itemId: string) {
    if (!isUuid(itemId)) throw new ApiError(404, 'Запись не найдена');
    const [row] = await db
      .select(kbItemColumns)
      .from(kbItems)
      .where(and(eq(kbItems.id, itemId), eq(kbItems.agentId, agentId)));
    if (!row) throw new ApiError(404, 'Запись не найдена');
    return row;
  }

  app.get(
    '/api/agents/:agentId/knowledge/items',
    { preHandler: [guard, anyMember] },
    async (req): Promise<KbItem[]> => {
      const parsed = listQuery.safeParse(req.query);
      if (!parsed.success) throw knowledgeError(parsed.error.issues[0]);
      const { kind, q } = parsed.data;
      const titles = await sourceTitles(req.agent!.id);

      // With a query the list IS the search: the owner's box and stage 5's agent must go
      // through the same ranker, or the owner is testing something the agent never sees.
      //
      // `kind` goes to the ranker rather than to a `.filter()` on what it returns: the
      // ranker cuts at SEARCH_LIMIT, so filtering afterwards would drop the items the caller
      // asked for whenever more than twenty match the words — ordinary after a site import,
      // and silent when it happens.
      if (q !== undefined && q.trim() !== '') {
        const hits = await searchKnowledge(db, req.agent!.id, q, SEARCH_LIMIT, { kind });
        return hits.map((hit) => toKbItem(hit.item, titles.get(hit.item.sourceId ?? '') ?? null));
      }

      const rows = await db
        .select(kbItemColumns)
        .from(kbItems)
        .where(
          kind === undefined
            ? eq(kbItems.agentId, req.agent!.id)
            : and(eq(kbItems.agentId, req.agent!.id), eq(kbItems.kind, kind)),
        )
        .orderBy(desc(kbItems.updatedAt))
        .limit(LIST_LIMIT);
      return rows.map((row) => toKbItem(row, titles.get(row.sourceId ?? '') ?? null));
    },
  );

  app.post(
    '/api/agents/:agentId/knowledge/items',
    { preHandler: [guard, anyMember] },
    async (req): Promise<KbItem> => {
      const parsed = createItem.safeParse(req.body);
      if (!parsed.success) throw knowledgeError(parsed.error.issues[0]);

      const [row] = await db
        .insert(kbItems)
        .values({ agentId: req.agent!.id, ...parsed.data })
        .returning(kbItemColumns);
      return toKbItem(row!, null);
    },
  );

  app.patch(
    '/api/agents/:agentId/knowledge/items/:itemId',
    { preHandler: [guard, anyMember] },
    async (req): Promise<KbItem> => {
      const { itemId } = req.params as { itemId: string };
      const current = await loadItem(req.agent!.id, itemId);

      const parsed = patchItem.safeParse(req.body);
      if (!parsed.success) throw knowledgeError(parsed.error.issues[0]);

      const titles = await sourceTitles(req.agent!.id);
      if (Object.keys(parsed.data).length === 0) {
        return toKbItem(current, titles.get(current.sourceId ?? '') ?? null);
      }

      const [row] = await db
        .update(kbItems)
        // `edited` is set here and only here. It is what a reimport reads to decide what
        // it may replace: a price the owner corrected outranks the page it came from.
        // `now()`, not `new Date()`: `createdAt` and the default `updatedAt` are written by
        // Postgres, and the two clocks disagree by tens of milliseconds. Stamping an edit
        // from this process can therefore date it before the insert it edits.
        .set({ ...parsed.data, edited: true, updatedAt: sql`now()` })
        .where(and(eq(kbItems.id, current.id), eq(kbItems.agentId, req.agent!.id)))
        .returning(kbItemColumns);
      return toKbItem(row!, titles.get(row!.sourceId ?? '') ?? null);
    },
  );

  app.delete(
    '/api/agents/:agentId/knowledge/items/:itemId',
    { preHandler: [guard, anyMember] },
    async (req): Promise<{ ok: true }> => {
      const { itemId } = req.params as { itemId: string };
      const current = await loadItem(req.agent!.id, itemId);

      await db
        .delete(kbItems)
        .where(and(eq(kbItems.id, current.id), eq(kbItems.agentId, req.agent!.id)));
      return { ok: true };
    },
  );

  app.get(
    '/api/agents/:agentId/knowledge/sources',
    { preHandler: [guard, anyMember] },
    async (req): Promise<KbSource[]> => {
      const rows = await db
        .select()
        .from(kbSources)
        .where(eq(kbSources.agentId, req.agent!.id))
        .orderBy(desc(kbSources.createdAt));
      return rows.map(toKbSource);
    },
  );

  /**
   * The items of one import, written in chunks inside the caller's transaction.
   *
   * Shared by the first import and the reimport, and chunked because a statement carries at
   * most 65534 bound parameters: `INSERT_CHUNK` is what keeps a site with thousands of
   * headings from becoming «Внутренняя ошибка сервера». It is still all of them or none —
   * the chunks run inside the transaction the caller opened.
   */
  async function insertItems(
    tx: Tx,
    agentId: string,
    sourceId: string,
    kind: (typeof KINDS)[number],
    parts: SplitPart[],
  ): Promise<KbRow[]> {
    const rows: KbRow[] = [];
    for (let from = 0; from < parts.length; from += INSERT_CHUNK) {
      const written = await tx
        .insert(kbItems)
        .values(
          parts.slice(from, from + INSERT_CHUNK).map((part) => ({
            agentId,
            sourceId,
            kind,
            title: part.title,
            content: part.content,
          })),
        )
        // Named columns, like every other read of an item: `returning()` would fetch the
        // generated tsvector and hand it straight to the response.
        .returning(kbItemColumns);
      rows.push(...written);
    }
    return rows;
  }

  /**
   * Writes a finished import: the source, then its items, in one transaction.
   *
   * Shared with task 4's page import, which differs only in where the parts came from.
   *
   * The caller describes the source — what kind it is, what it is called, where it came
   * from — and nothing else: the tenancy, the outcome and the count are this function's to
   * write, and a caller that could pass its own `itemCount` could disagree with the items
   * it just handed us.
   */
  async function storeImport(
    agentId: string,
    source: Omit<typeof kbSources.$inferInsert, 'agentId' | 'status' | 'itemCount' | 'importedAt'>,
    kind: (typeof KINDS)[number],
    parts: SplitPart[],
  ): Promise<KbImport> {
    return db.transaction(async (tx) => {
      const [created] = await tx
        .insert(kbSources)
        .values({
          ...source,
          agentId,
          status: 'ready',
          itemCount: parts.length,
          importedAt: new Date(),
        })
        .returning();

      const rows = await insertItems(tx, agentId, created!.id, kind, parts);

      return {
        source: toKbSource(created!),
        items: rows.map((row) => toKbItem(row, created!.title)),
        // A source that did not exist a moment ago has nothing kept and nothing edited.
        reimported: false,
        keptEdited: 0,
      };
    });
  }

  app.post(
    '/api/agents/:agentId/knowledge/import/text',
    { preHandler: [guard, ownerOnly] },
    async (req): Promise<KbImport> => {
      const parsed = importText.safeParse(req.body);
      if (!parsed.success) throw knowledgeError(parsed.error.issues[0]);

      const parts = splitBlocks(parsed.data.text);
      // Refused before anything is written: a source with no items is a row that says an
      // import happened and shows nothing for it.
      if (parts.length === 0) throw new ApiError(400, 'В тексте нечего сохранить');

      return storeImport(
        req.agent!.id,
        { kind: 'text', title: parsed.data.title },
        parsed.data.kind,
        parts,
      );
    },
  );

  /** One source of this agent's, or 404 — never another agent's, and never a bare 500. */
  async function loadSource(agentId: string, sourceId: string) {
    if (!isUuid(sourceId)) throw new ApiError(404, 'Источник не найден');
    const [row] = await db
      .select()
      .from(kbSources)
      .where(and(eq(kbSources.id, sourceId), eq(kbSources.agentId, agentId)));
    if (!row) throw new ApiError(404, 'Источник не найден');
    return row;
  }

  /**
   * A refetched page written onto the source it belongs to.
   *
   * The rule is short on purpose: **every unedited item of this source goes, every part the
   * page now yields is written, and what a person edited is left alone.** No part of the
   * fresh page is ever dropped, and no title is ever compared with another.
   *
   * Matching fresh parts against the titles of the kept items — which is what this did — was
   * an attempt to guess which fresh part «is» a kept one, and it guessed wrong in every way
   * a real page moves. Two sections called «Цены» produced two items; the owner edited one;
   * the title filter then discarded BOTH fresh sections and the other section's prices left
   * the base with nothing to say they had gone. A renamed section left the correction under
   * the old name beside a fresh item under the new one. A long section whose numbering
   * changed left «Прайс (2)» behind as a fragment of a page that no longer exists.
   *
   * So it does not guess. An edited item and a fresh item may now say different things about
   * the same subject, and `keptEdited` is how the owner is told to go and look: that is a
   * question about the world — has the page moved on, or was the correction right? — and it
   * is theirs to answer, not ours to answer for them by deleting one of the two.
   */
  async function applyReimport(
    agentId: string,
    source: typeof kbSources.$inferSelect,
    page: FetchedPage,
    parts: SplitPart[],
  ): Promise<KbImport> {
    return db.transaction(async (tx) => {
      const mine = and(eq(kbItems.sourceId, source.id), eq(kbItems.agentId, agentId));

      // Read before the delete, and by `edited`: these rows are a person's work, not the
      // page's, and this import has no claim on them.
      const kept = await tx
        .select(kbItemColumns)
        .from(kbItems)
        .where(and(mine, eq(kbItems.edited, true)));
      await tx.delete(kbItems).where(and(mine, eq(kbItems.edited, false)));

      const written = await insertItems(tx, agentId, source.id, 'other', parts);

      const [updated] = await tx
        .update(kbSources)
        .set({
          title: pageTitle(page.html, page.finalUrl),
          url: page.finalUrl,
          status: 'ready',
          // Cleared, not left behind: this attempt succeeded, and a stale reason beside a
          // ready source reads as a failure that is still happening.
          error: null,
          itemCount: kept.length + written.length,
          importedAt: new Date(),
        })
        .where(and(eq(kbSources.id, source.id), eq(kbSources.agentId, agentId)))
        .returning();

      return {
        source: toKbSource(updated!),
        items: [...kept, ...written].map((row) => toKbItem(row, updated!.title)),
        reimported: true,
        keptEdited: kept.length,
      };
    });
  }

  /** Why this source's last attempt did not work. Its items are not touched. */
  async function markFailed(sourceId: string, agentId: string, reason: string): Promise<void> {
    await db
      .update(kbSources)
      .set({ status: 'failed', error: reason })
      .where(and(eq(kbSources.id, sourceId), eq(kbSources.agentId, agentId)));
  }

  /** The page's text as items — empty when there was nothing on it worth keeping. */
  const partsOf = (page: FetchedPage): SplitPart[] => splitByHeadings(htmlToText(page.html));

  /**
   * The one row this agent already has for a page address, whatever state it is in.
   *
   * One row per address is the promise the sources list makes, and it has to hold across
   * outcomes, not only within one: a failed attempt followed by a success used to leave two
   * rows for the same page, because only the failure path looked for an existing row. The
   * second row then had the items and the first still said «не удалось», and the next
   * failure — which found rows in an order Postgres never promised — could mark either.
   *
   * Hence: no status in the `where`, an order that is the same on every call, and one row.
   * The oldest wins, because that is the row the owner has been looking at; a database that
   * still carries a pair from before this fix converges on it rather than alternating.
   */
  async function findPageSource(agentId: string, url: string) {
    const [row] = await db
      .select()
      .from(kbSources)
      .where(
        and(eq(kbSources.agentId, agentId), eq(kbSources.kind, 'page'), eq(kbSources.url, url)),
      )
      .orderBy(asc(kbSources.createdAt), asc(kbSources.id))
      .limit(1);
    return row;
  }

  /**
   * Records a failed attempt against the address, reusing the row if there already is one.
   *
   * One row per address, not one per attempt: an owner whose site is down presses the button
   * again, and again, and ten identical «не удалось» rows in their sources list bury the
   * imports that worked. The row is the standing answer to «what happened with this
   * address», so it is overwritten rather than added to.
   */
  async function recordFailure(agentId: string, url: string, reason: string): Promise<void> {
    const existing = await findPageSource(agentId, url);

    if (existing) {
      await markFailed(existing.id, agentId, reason);
      return;
    }

    await db.insert(kbSources).values({
      agentId,
      kind: 'page',
      title: pageTitle('', url),
      url,
      status: 'failed',
      error: reason,
    });
  }

  app.post(
    '/api/agents/:agentId/knowledge/import/page',
    { preHandler: [guard, ownerOnly] },
    async (req): Promise<KbImport> => {
      const parsed = importPage.safeParse(req.body);
      if (!parsed.success) throw knowledgeError(parsed.error.issues[0]);
      const url = targetUrl(parsed.data.url);

      let page: FetchedPage;
      try {
        page = await pageFetcher.fetch(url.href);
      } catch (error) {
        // The attempt is kept. The owner pasted an address, waited, and got an error; a
        // sources list that then shows nothing at all leaves them unable to tell a refusal
        // from a page that quietly imported as empty.
        await recordFailure(req.agent!.id, url.href, PAGE_REFUSED);
        app.log.warn(
          { url: url.href, detail: failureDetail(error) },
          'knowledge page import failed',
        );
        throw new ApiError(502, PAGE_REFUSED);
      }

      // The address this agent already has, if it has it. Pasting a URL a second time is
      // «Обновить» spelled another way — the owner means «read this page again» either way —
      // and without this it was a second source and a second copy of every item, with the
      // two drifting apart from the next reimport onwards.
      //
      // Both the typed address and where it ended up are looked for: the row stores the
      // final URL, so a page that redirects would otherwise be found by neither the address
      // the owner keeps typing nor, on the first pass, by anything else.
      const existing =
        (await findPageSource(req.agent!.id, url.href)) ??
        (await findPageSource(req.agent!.id, page.finalUrl));

      const parts = partsOf(page);
      // Refused before anything is written: a source with no items is a row that says an
      // import happened and shows nothing for it. More often than not this is a page whose
      // text arrives from JavaScript, and the honest answer is that we read it and there was
      // nothing there — which is the owner's to act on, so it says so.
      //
      // An address we already have is marked failed instead, exactly as «Обновить» does: its
      // items stay, and the row has to stop claiming a success that this attempt was not.
      if (parts.length === 0) {
        if (existing) await markFailed(existing.id, req.agent!.id, NOTHING_TO_SAVE);
        throw new ApiError(400, NOTHING_TO_SAVE);
      }

      if (existing) return applyReimport(req.agent!.id, existing, page, parts);

      return storeImport(
        req.agent!.id,
        // `finalUrl`, not what was typed: the fetcher follows redirects hop by hop, and the
        // page the text came from is the one worth reimporting later.
        { kind: 'page', title: pageTitle(page.html, page.finalUrl), url: page.finalUrl },
        'other',
        parts,
      );
    },
  );

  app.post(
    '/api/agents/:agentId/knowledge/sources/:sourceId/reimport',
    { preHandler: [guard, ownerOnly] },
    async (req): Promise<KbImport> => {
      const { sourceId } = req.params as { sourceId: string };
      const source = await loadSource(req.agent!.id, sourceId);
      if (source.kind !== 'page' || !source.url) {
        throw new ApiError(400, 'Обновить можно только импорт страницы');
      }

      // Fetched before anything is deleted, and outside the transaction: a site that is
      // down for an hour must not empty the knowledge base while it is.
      let page: FetchedPage;
      try {
        page = await pageFetcher.fetch(source.url);
      } catch (error) {
        await markFailed(source.id, req.agent!.id, PAGE_REFUSED);
        app.log.warn(
          { url: source.url, detail: failureDetail(error) },
          'knowledge page reimport failed',
        );
        throw new ApiError(502, PAGE_REFUSED);
      }

      const parts = partsOf(page);
      // Marked failed before answering, exactly as a failed fetch is. The items stay — they
      // are still the best answer we have — but leaving the source `ready` with the
      // `itemCount` of the previous import would have it claim a success that did not
      // happen, and the owner would have no idea the page had stopped yielding anything.
      if (parts.length === 0) {
        await markFailed(source.id, req.agent!.id, NOTHING_TO_SAVE);
        throw new ApiError(400, NOTHING_TO_SAVE);
      }

      return applyReimport(req.agent!.id, source, page, parts);
    },
  );

  app.delete(
    '/api/agents/:agentId/knowledge/sources/:sourceId',
    { preHandler: [guard, ownerOnly] },
    async (req): Promise<{ ok: true }> => {
      const { sourceId } = req.params as { sourceId: string };
      const source = await loadSource(req.agent!.id, sourceId);

      // Only the source row goes. Its items stay, with `sourceId` set to null by the
      // schema's `on delete set null` — they are the facts the agent answers from and the
      // corrections someone made to them, and forgetting the address they came from is not
      // a decision to forget those.
      await db
        .delete(kbSources)
        .where(and(eq(kbSources.id, source.id), eq(kbSources.agentId, req.agent!.id)));
      return { ok: true };
    },
  );
}
