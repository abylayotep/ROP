import type {
  KbGraph,
  KbImport,
  KbNote,
  KbNoteDetail,
  KbNoteKind,
  KbSection,
  KbSource,
} from '@rakurs/contract';
import { and, asc, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { kbChunks, kbLinks, kbNotes, kbSources } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import {
  PAGE_REFUSED,
  PageError,
  fetchPage,
  pageTitle,
  type PageFetcher,
  type PageMarkdown,
} from '../lib/knowledge/fetch-page.js';
import { BODY_MAX } from '../lib/knowledge/note.js';
import { deleteNote, saveNote, type SaveNoteInput } from '../lib/knowledge/notes.js';
import { kbChunkColumns, searchKnowledge, type KbRow } from '../lib/knowledge/search.js';
// pleep's own limits, and they are the right shape: a fact, not an essay. They live beside
// the splitter because that is the code that has to cut to fit them; a second copy here
// would be one edit away from letting the splitter produce what this route rejects.
import { TITLE_MAX, splitBlocks, type SplitPart } from '../lib/knowledge/split.js';
import { isUuid } from '../lib/uuid.js';
import { requireAgent } from './require-agent.js';

const KINDS = ['product', 'qa', 'procedure', 'contact', 'other'] as const;

/** A paste bigger than this is a file, not a note, and files are not this stage. */
const PASTE_MAX = 200_000;
/** A search nobody scrolls past. Stage 5 asks for far fewer. */
const SEARCH_LIMIT = 20;
/**
 * The browse list is capped separately, and higher.
 *
 * Twenty is right for a search, where the ranker has put the answer near the top; browsing
 * the vault is the other thing this route does, and cutting it at twenty would hide most of
 * what a site import produced. Unbounded is not the alternative: an import yields dozens of
 * notes per page, and `SELECT *` over all of them is a response that grows with the
 * customer's website. A hundred is a screen's worth of scrolling, and the search box — the
 * same route with `q` — is how the rest is reached until the screen paginates.
 */
const LIST_LIMIT = 100;
/**
 * The graph tab is a picture, not a table: a thousand nodes on one canvas stops being
 * readable long before it stops being fast to fetch. 500 is a vault a small business could
 * plausibly write by hand; past that the tab should say so rather than pretend to draw it.
 */
const GRAPH_LIMIT = 500;

/**
 * A path is folders and a name. Bounded because it is an identity people type: a leading
 * slash, an empty segment or a tenth folder is a mistake we can name rather than store.
 */
const notePath = z
  .string()
  .trim()
  .min(1)
  .max(400)
  .refine(
    (path) => !path.startsWith('/') && !path.endsWith('/'),
    'Название не может начинаться или заканчиваться косой чертой',
  )
  .refine((path) => path.split('/').every((part) => part.trim() !== ''), 'В названии есть пустая папка')
  .refine((path) => path.split('/').length <= 10, 'Слишком глубокая вложенность');

const createNote = z.object({ path: notePath, body: z.string().max(BODY_MAX).default('') });
const updateNote = z.object({ path: notePath.optional(), body: z.string().max(BODY_MAX).optional() });

/**
 * The message for the field that actually failed a note write.
 *
 * `issue.message` is passed through only for `custom` — our own `refine`s above, which
 * already wrote it in Russian. Every other zod code (`too_small`, `invalid_type`, and
 * whatever a future zod version adds) falls back to one of the two messages below instead of
 * leaking zod's own English text to a cabinet user.
 */
function noteError(issue: { code: string; path: readonly PropertyKey[]; message: string } | undefined): ApiError {
  if (!issue) return new ApiError(400, 'Не удалось разобрать заметку');
  if (issue.path[0] === 'body') {
    return new ApiError(400, `Текст длиннее ${BODY_MAX} символов`);
  }
  if (issue.code === 'custom') return new ApiError(400, issue.message);
  if (issue.code === 'too_big') return new ApiError(400, 'Название длиннее 400 символов');
  return new ApiError(400, 'Укажите название');
}

const queryParam = z.object({ q: z.string().optional() });

const importPage = z.object({
  url: z.string().trim().min(1).max(2048),
});

const importText = z.object({
  title: z.string().trim().min(1).max(TITLE_MAX),
  kind: z.enum(KINDS).default('other'),
  text: z.string().max(PASTE_MAX),
});

/**
 * The message for the field that actually failed an import.
 *
 * One message for the whole body would answer an unknown `kind` by talking about the length
 * of a title the sender got right. The reader has to be told which field it was.
 */
function importError(issue: { code: string; path: readonly PropertyKey[] } | undefined): ApiError {
  const tooBig = issue?.code === 'too_big';
  switch (issue?.path[0]) {
    case 'kind':
      return new ApiError(400, `Неизвестный тип записи. Возможные: ${KINDS.join(', ')}`);
    case 'title':
      return tooBig
        ? new ApiError(400, `Заголовок длиннее ${TITLE_MAX} символов`)
        : new ApiError(400, 'Укажите заголовок');
    // The pasted body of an import. It has its own limit — a paste is allowed to be far
    // longer than one note, because the splitter is about to cut it into several — and it
    // branches for the same reason the others do: a body with no `text` at all told the
    // sender its text was too long, which is precisely the confusion this helper exists for.
    case 'text':
      return tooBig
        ? new ApiError(400, `Текст длиннее ${PASTE_MAX} символов`)
        : new ApiError(400, 'Вставьте текст для импорта');
    case 'url':
      return tooBig
        ? new ApiError(400, `Адрес длиннее 2048 символов`)
        : new ApiError(400, 'Укажите адрес страницы');
    default:
      return new ApiError(400, 'Не удалось разобрать запись');
  }
}

/**
 * Postgres reports a unique violation with this code. Drizzle wraps the driver error in
 * its own `DrizzleQueryError`, so the code sits on `.cause`, not on the error itself.
 */
function isDuplicate(error: unknown): boolean {
  const cause = error instanceof Error ? error.cause : undefined;
  return typeof cause === 'object' && cause !== null && (cause as { code?: string }).code === '23505';
}

const toKbNote = (row: typeof kbNotes.$inferSelect, sourceTitle: string | null): KbNote => ({
  id: row.id,
  path: row.path,
  title: row.title,
  kind: row.kind as KbNoteKind,
  tags: row.tags,
  edited: row.edited,
  sourceId: row.sourceId,
  sourceTitle,
  updatedAt: row.updatedAt.toISOString(),
});

const toKbSection = (chunk: KbRow): KbSection => ({
  id: chunk.id,
  noteId: chunk.noteId,
  title: chunk.title,
  heading: chunk.heading,
  content: chunk.content,
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
 * The address a page source is known by: what the owner typed, tidied.
 *
 * **The identity of a page source is the typed address, never where the fetch ended up.**
 * The final URL is knowable only when the fetch succeeds, and a key that exists on one path
 * and not the other is not a key: a failure on a redirecting address — `http` to `https`, or
 * bare to `www`, which is most real sites — could not find the row the successful import had
 * written under the final URL, so it inserted a second one. The next success rewrote that
 * row's url to the final URL, and the sources list held two rows for one address with the
 * notes split between them and the younger one unreachable for good. The typed address is
 * known before the fetch, after a failed fetch, and after a successful one, and it is also
 * the thing the owner will paste again.
 *
 * The redirect is not lost by this — it is followed again on every read, which is what a
 * redirect is for.
 *
 * Tidied, because three spellings of one page are one page and were three sources with a
 * full duplicate set of notes each:
 *
 * - the fragment goes: `#top` is a position in a page, and it never reaches the server;
 * - a trailing slash goes, except on the root: `/prices` and `/prices/` are one page
 *   everywhere that is not a deliberately broken server;
 * - the scheme and host are lowercased, which `URL` does for us.
 *
 * **The query string is left exactly as it is.** `?id=5` is very often the page itself, and
 * folding it away would merge a whole catalogue into one source — a worse failure than the
 * duplicates this prevents, and a silent one.
 */
function pageKey(url: URL): string {
  const key = new URL(url.href);
  key.hash = '';
  key.pathname = key.pathname.replace(/\/+$/, '') || '/';
  return key.href;
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

  /** The titles of the sources these notes came from, in one query rather than per row. */
  async function sourceTitles(agentId: string): Promise<Map<string, string>> {
    const rows = await db
      .select({ id: kbSources.id, title: kbSources.title })
      .from(kbSources)
      .where(eq(kbSources.agentId, agentId));
    return new Map(rows.map((row) => [row.id, row.title]));
  }

  /** One agent's source's title, or null for a hand-written note. A single lookup for one row. */
  async function sourceTitleOf(sourceId: string | null): Promise<string | null> {
    if (sourceId === null) return null;
    const [row] = await db.select({ title: kbSources.title }).from(kbSources).where(eq(kbSources.id, sourceId));
    return row?.title ?? null;
  }

  /** One agent's note, or 404 — never another agent's, and never a bare 500. */
  async function loadNote(agentId: string, noteId: string): Promise<typeof kbNotes.$inferSelect> {
    if (!isUuid(noteId)) throw new ApiError(404, 'Заметка не найдена');
    const [row] = await db
      .select()
      .from(kbNotes)
      .where(and(eq(kbNotes.id, noteId), eq(kbNotes.agentId, agentId)));
    if (!row) throw new ApiError(404, 'Заметка не найдена');
    return row;
  }

  /** A note opened: its text, its sections, and what points at it, joined in three queries. */
  async function loadNoteDetail(agentId: string, noteId: string): Promise<KbNoteDetail> {
    const note = await loadNote(agentId, noteId);

    const [sourceTitle, chunkRows, backlinkRows, linkRows] = await Promise.all([
      sourceTitleOf(note.sourceId),
      db.select(kbChunkColumns).from(kbChunks).where(eq(kbChunks.noteId, note.id)).orderBy(asc(kbChunks.ordinal)),
      // Notes that link here: the title shown is the linking note's own, not the text it
      // wrote inside `[[...]]` — those can disagree once either note is renamed.
      db
        .select({ noteId: kbLinks.fromNoteId, title: kbNotes.title })
        .from(kbLinks)
        .innerJoin(kbNotes, eq(kbNotes.id, kbLinks.fromNoteId))
        .where(and(eq(kbLinks.agentId, agentId), eq(kbLinks.toNoteId, note.id))),
      // What this note links to: the text it wrote, resolved if it matched a title.
      db
        .select({ noteId: kbLinks.toNoteId, title: kbLinks.target })
        .from(kbLinks)
        .where(and(eq(kbLinks.agentId, agentId), eq(kbLinks.fromNoteId, note.id))),
    ]);

    return {
      ...toKbNote(note, sourceTitle),
      body: note.body,
      sections: chunkRows.map(toKbSection),
      backlinks: backlinkRows,
      links: linkRows,
    };
  }

  app.get(
    '/api/agents/:agentId/knowledge/notes',
    { preHandler: [guard, anyMember] },
    async (req): Promise<KbNote[]> => {
      const parsed = queryParam.safeParse(req.query);
      if (!parsed.success) throw new ApiError(400, 'Не удалось разобрать запрос');
      const { q } = parsed.data;
      const titles = await sourceTitles(req.agent!.id);

      // With a query the list IS the search: the owner's box and the agent must go through
      // the same ranker, or the owner is testing something the agent never sees.
      if (q !== undefined && q.trim() !== '') {
        const hits = await searchKnowledge(db, req.agent!.id, q, SEARCH_LIMIT);

        // The distinct notes of the hits, in the ranker's own order. Deduplicating with a
        // second, differently-ordered query — `SELECT DISTINCT noteId ... ORDER BY updatedAt`,
        // say — would show the owner a list that agrees with the ranker on membership and
        // disagrees with it on order, which is worse than not deduplicating at all: the
        // point of asking the same ranker the agent uses is to see what it saw, in the order
        // it saw it. So the order is read off `hits`, which `searchKnowledge` has already cut
        // at `SEARCH_LIMIT` — deduplicating a *second* time at that limit would be sound, but
        // deduplicating before it (a `DISTINCT` inside the ranker's own query) is not: it would
        // let one match per note through the cut instead of the best `SEARCH_LIMIT` sections,
        // silently hiding a note whose only good match ranked just below a worse section of
        // a note already counted.
        const noteIds: string[] = [];
        const seen = new Set<string>();
        for (const hit of hits) {
          if (!seen.has(hit.chunk.noteId)) {
            seen.add(hit.chunk.noteId);
            noteIds.push(hit.chunk.noteId);
          }
        }
        if (noteIds.length === 0) return [];

        const rows = await db
          .select()
          .from(kbNotes)
          .where(and(eq(kbNotes.agentId, req.agent!.id), inArray(kbNotes.id, noteIds)));
        const byId = new Map(rows.map((row) => [row.id, row]));
        return noteIds.flatMap((id) => {
          const row = byId.get(id);
          return row ? [toKbNote(row, titles.get(row.sourceId ?? '') ?? null)] : [];
        });
      }

      const rows = await db
        .select()
        .from(kbNotes)
        .where(eq(kbNotes.agentId, req.agent!.id))
        .orderBy(desc(kbNotes.updatedAt))
        .limit(LIST_LIMIT);
      return rows.map((row) => toKbNote(row, titles.get(row.sourceId ?? '') ?? null));
    },
  );

  app.post(
    '/api/agents/:agentId/knowledge/notes',
    { preHandler: [guard, anyMember] },
    async (req): Promise<KbNoteDetail> => {
      const parsed = createNote.safeParse(req.body);
      if (!parsed.success) throw noteError(parsed.error.issues[0]);

      let noteId: string;
      try {
        noteId = await db.transaction(async (tx) => {
          const note = await saveNote(tx as unknown as Db, {
            agentId: req.agent!.id,
            path: parsed.data.path,
            body: parsed.data.body,
          });
          return note.id;
        });
      } catch (error) {
        if (isDuplicate(error)) throw new ApiError(409, 'Заметка с таким названием уже есть');
        throw error;
      }
      return loadNoteDetail(req.agent!.id, noteId);
    },
  );

  app.get(
    '/api/agents/:agentId/knowledge/notes/:noteId',
    { preHandler: [guard, anyMember] },
    async (req): Promise<KbNoteDetail> => {
      const { noteId } = req.params as { noteId: string };
      return loadNoteDetail(req.agent!.id, noteId);
    },
  );

  app.patch(
    '/api/agents/:agentId/knowledge/notes/:noteId',
    { preHandler: [guard, anyMember] },
    async (req): Promise<KbNoteDetail> => {
      const { noteId } = req.params as { noteId: string };
      const current = await loadNote(req.agent!.id, noteId);

      const parsed = updateNote.safeParse(req.body);
      if (!parsed.success) throw noteError(parsed.error.issues[0]);

      try {
        await db.transaction((tx) =>
          saveNote(tx as unknown as Db, {
            agentId: req.agent!.id,
            noteId: current.id,
            path: parsed.data.path ?? current.path,
            body: parsed.data.body ?? current.body,
            sourceId: current.sourceId,
            // Set here and only here. It is what a reimport reads to decide what it may
            // replace: a page the owner corrected by hand outranks the page it came from.
            edited: true,
          }),
        );
      } catch (error) {
        if (isDuplicate(error)) throw new ApiError(409, 'Заметка с таким названием уже есть');
        throw error;
      }
      return loadNoteDetail(req.agent!.id, current.id);
    },
  );

  app.delete(
    '/api/agents/:agentId/knowledge/notes/:noteId',
    { preHandler: [guard, anyMember] },
    async (req): Promise<{ ok: true }> => {
      const { noteId } = req.params as { noteId: string };
      const current = await loadNote(req.agent!.id, noteId);
      await db.transaction((tx) => deleteNote(tx as unknown as Db, req.agent!.id, current.id));
      return { ok: true };
    },
  );

  app.get(
    '/api/agents/:agentId/knowledge/search',
    { preHandler: [guard, anyMember] },
    async (req): Promise<KbSection[]> => {
      const parsed = queryParam.safeParse(req.query);
      if (!parsed.success) throw new ApiError(400, 'Не удалось разобрать запрос');
      const { q } = parsed.data;
      // A blank query is answered with nothing rather than sent to the ranker: see
      // `searchKnowledge`'s own note on why a blank tsquery is not "everything".
      if (q === undefined || q.trim() === '') return [];

      const hits = await searchKnowledge(db, req.agent!.id, q, SEARCH_LIMIT);
      return hits.map((hit) => toKbSection(hit.chunk));
    },
  );

  app.get(
    '/api/agents/:agentId/knowledge/graph',
    { preHandler: [guard, anyMember] },
    async (req): Promise<KbGraph> => {
      const rows = await db
        .select({ id: kbNotes.id, title: kbNotes.title, path: kbNotes.path })
        .from(kbNotes)
        .where(eq(kbNotes.agentId, req.agent!.id))
        .orderBy(asc(kbNotes.createdAt), asc(kbNotes.id))
        // One past the cap, purely to tell a vault of exactly 500 notes apart from one of
        // 5000: the response would look identical at the cap alone.
        .limit(GRAPH_LIMIT + 1);
      const truncated = rows.length > GRAPH_LIMIT;
      const notes = truncated ? rows.slice(0, GRAPH_LIMIT) : rows;

      // Only links whose target resolved: a link to a title nothing carries is shown on the
      // note itself (`KbNoteDetail.links`), not as an edge to a node the graph does not draw.
      const linkRows = await db
        .select({ from: kbLinks.fromNoteId, to: kbLinks.toNoteId })
        .from(kbLinks)
        .where(and(eq(kbLinks.agentId, req.agent!.id), isNotNull(kbLinks.toNoteId)));

      return {
        notes,
        links: linkRows.map((row) => ({ from: row.from, to: row.to! })),
        truncated,
      };
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
   * A free path under `folder` for `title`, the way migration 0012 turned every `kb_items`
   * row into a `kb_notes` one: try the plain name, then `" (2)"`, `" (3)"`, … until one is not
   * already somebody's.
   *
   * Probed one candidate at a time inside the caller's own transaction rather than computed
   * up front, because a batch import writes its notes one by one in that same transaction: a
   * second paste titled the same as an earlier note sees that note's path already taken —
   * whether it was written earlier in this very call or committed by a previous one — and
   * lands on the next free number instead of the 409 a plain insert would answer with.
   */
  async function uniquePath(tx: Tx, agentId: string, folder: string, title: string): Promise<string> {
    // A slash in a title would open a folder nobody asked for; the migration met the same
    // problem in `item.title` and answered it the same way.
    const base = `${folder}/${title.replace(/\//g, '∕')}`;
    for (let suffix = 1; ; suffix += 1) {
      const candidate = suffix === 1 ? base : `${base} (${suffix})`;
      const [existing] = await tx
        .select({ id: kbNotes.id })
        .from(kbNotes)
        .where(and(eq(kbNotes.agentId, agentId), eq(kbNotes.path, candidate)));
      if (!existing) return candidate;
    }
  }

  /**
   * `uniquePath` followed by the write it was computed for, with the one race that can still
   * happen between them covered.
   *
   * The probe above answers correctly for everything writing inside this same transaction —
   * that is what "inside the caller's own transaction" on `uniquePath` buys — but not for a
   * second import racing it from a different transaction: both can probe the same free
   * candidate before either commits, and one of the two inserts then hits the `kb_notes_agent_
   * path_key` unique index. Rather than serializing every write behind a lock for a
   * collision that needs two imports of the same title landing at the same instant, the write
   * runs inside its own savepoint (`tx.transaction`, which `PostgresJsTransaction` turns into a
   * real `SAVEPOINT`): a `23505` rolls back just that attempt, `uniquePath` is asked again
   * against whatever just committed, and the next candidate is tried.
   */
  async function saveNoteAtUniquePath(
    tx: Tx,
    agentId: string,
    folder: string,
    title: string,
    rest: Omit<SaveNoteInput, 'agentId' | 'path'>,
  ): Promise<typeof kbNotes.$inferSelect> {
    for (;;) {
      const path = await uniquePath(tx, agentId, folder, title);
      try {
        return await tx.transaction((inner) => saveNote(inner as unknown as Db, { agentId, path, ...rest }));
      } catch (error) {
        if (!isDuplicate(error)) throw error;
      }
    }
  }

  /** One pasted block, written as its own note under `Вставки/`, numbered clear of collisions. */
  async function insertPasteNotes(
    tx: Tx,
    agentId: string,
    sourceId: string,
    kind: (typeof KINDS)[number],
    parts: SplitPart[],
  ): Promise<(typeof kbNotes.$inferSelect)[]> {
    const rows: (typeof kbNotes.$inferSelect)[] = [];
    for (const part of parts) {
      const body = kind === 'other' ? part.content : `---\nkind: ${kind}\n---\n\n${part.content}`;
      rows.push(await saveNoteAtUniquePath(tx, agentId, 'Вставки', part.title, { body, sourceId }));
    }
    return rows;
  }

  /** Writes a finished paste import: the source, then one note per block, in one transaction. */
  async function storeTextImport(
    agentId: string,
    title: string,
    kind: (typeof KINDS)[number],
    parts: SplitPart[],
  ): Promise<KbImport> {
    return db.transaction(async (tx) => {
      const [created] = await tx
        .insert(kbSources)
        .values({ kind: 'text', title, agentId, status: 'ready', itemCount: parts.length, importedAt: new Date() })
        .returning();

      const rows = await insertPasteNotes(tx, agentId, created!.id, kind, parts);

      return {
        source: toKbSource(created!),
        notes: rows.map((row) => toKbNote(row, created!.title)),
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
      if (!parsed.success) throw importError(parsed.error.issues[0]);

      const parts = splitBlocks(parsed.data.text);
      // Refused before anything is written: a source with no notes is a row that says an
      // import happened and shows nothing for it.
      if (parts.length === 0) throw new ApiError(400, 'В тексте нечего сохранить');

      return storeTextImport(req.agent!.id, parsed.data.title, parsed.data.kind, parts);
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
   * A page's fresh content is always written, whatever else the source held: an edited note
   * is a person's correction and is kept rather than overwritten, but that is not a reason to
   * withhold the page's current content. A legacy source (migration 0012 gave every
   * pre-existing page source one note per old record) can hold several of these; if even one
   * of them was edited, refusing to write the fresh note anywhere would make the page's real
   * content vanish with no trace the next time this source is read. There is no title to match
   * a fresh part against a kept one by — the mistake the item-based predecessor of this
   * function made — so every untouched (`edited = false`) note goes first, and the fresh note
   * lands wherever `uniquePath` finds room, beside a kept one if it must.
   */
  async function applyReimport(
    agentId: string,
    source: typeof kbSources.$inferSelect,
    page: PageMarkdown,
  ): Promise<KbImport> {
    return db.transaction(async (tx) => {
      const mine = and(eq(kbNotes.sourceId, source.id), eq(kbNotes.agentId, agentId));

      // Read before the delete, and by `edited`: this row is a person's work, not the
      // page's, and this import has no claim on it.
      const kept = await tx.select().from(kbNotes).where(and(mine, eq(kbNotes.edited, true)));
      const stale = await tx.select({ id: kbNotes.id }).from(kbNotes).where(and(mine, eq(kbNotes.edited, false)));
      // Through `deleteNote`, not a bulk delete: a note's chunks and the links it resolves
      // are derived from it, and only `deleteNote` knows to take them with it.
      for (const row of stale) await deleteNote(tx as unknown as Db, agentId, row.id);

      // Written unconditionally, even beside a kept, edited note: a duplicate beside an
      // edited note is the honest answer here, and a page silently withheld because its slot
      // was taken is not. It does not accumulate across refreshes — the previous fresh note
      // is unedited and was just deleted above, along with the rest of `stale`, so `uniquePath`
      // finds the same ` (2)` free again rather than moving on to ` (3)`.
      const written = [
        await saveNoteAtUniquePath(tx, agentId, 'С сайта', page.title, {
          body: page.markdown,
          sourceId: source.id,
        }),
      ];

      const [updated] = await tx
        .update(kbSources)
        .set({
          title: page.title,
          // `url` is not written back. It is what this source is known by, and a reimport
          // that moved it to wherever the redirects ended would make the row unfindable by
          // the address the owner keeps typing — which is the whole bug this key exists for.
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
        notes: [...kept, ...written].map((row) => toKbNote(row, updated!.title)),
        reimported: true,
        keptEdited: kept.length,
      };
    });
  }

  /** Why this source's last attempt did not work. Its notes are not touched. */
  async function markFailed(sourceId: string, agentId: string, reason: string): Promise<void> {
    await db
      .update(kbSources)
      .set({ status: 'failed', error: reason })
      .where(and(eq(kbSources.id, sourceId), eq(kbSources.agentId, agentId)));
  }

  /**
   * What «Обновить» answers when the refetch itself did not work: the source, now saying so,
   * beside the notes it already had — read back rather than assumed, because nothing on this
   * path touched them.
   *
   * Unlike a first import, which has no source and nothing to show for a failed fetch, a
   * refresh has one already, and its new `status` is itself the answer the owner is waiting
   * on: reporting it here is what lets the screen redraw the source row without a second
   * request, rather than a bare error the owner reads as a formality of the button they
   * pressed on a source that keeps sitting in front of them.
   */
  async function failedReimport(agentId: string, sourceId: string): Promise<KbImport> {
    const updated = await loadSource(agentId, sourceId);
    const rows = await db
      .select()
      .from(kbNotes)
      .where(and(eq(kbNotes.sourceId, sourceId), eq(kbNotes.agentId, agentId)));
    return {
      source: toKbSource(updated),
      notes: rows.map((row) => toKbNote(row, updated.title)),
      reimported: true,
      keptEdited: rows.filter((row) => row.edited).length,
    };
  }

  /**
   * The one row this agent already has for a page address, whatever state it is in.
   *
   * One row per address is the promise the sources list makes, and it has to hold across
   * outcomes, not only within one: a failed attempt followed by a success used to leave two
   * rows for the same page, because only the failure path looked for an existing row. The
   * second row then had the notes and the first still said «не удалось», and the next
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
      if (!parsed.success) throw importError(parsed.error.issues[0]);
      // One key, from the address itself, so every path below — the failure, the lookup, the
      // insert and the reimport — names this source the same way. See `pageKey`.
      const url = pageKey(targetUrl(parsed.data.url));

      let page: PageMarkdown;
      try {
        page = await fetchPage(url, pageFetcher);
      } catch (error) {
        // The attempt is kept. The owner pasted an address, waited, and got an error; a
        // sources list that then shows nothing at all leaves them unable to tell a refusal
        // from a page that quietly imported as empty.
        await recordFailure(req.agent!.id, url, PAGE_REFUSED);
        app.log.warn({ url, detail: failureDetail(error) }, 'knowledge page import failed');
        throw new ApiError(502, PAGE_REFUSED);
      }

      // The address this agent already has, if it has it. Pasting a URL a second time is
      // «Обновить» spelled another way — the owner means «read this page again» either way —
      // and without this it was a second source and a second copy of every note, with the
      // two drifting apart from the next reimport onwards.
      const existing = await findPageSource(req.agent!.id, url);

      // Refused before anything is written: a source with no notes is a row that says an
      // import happened and shows nothing for it. More often than not this is a page whose
      // text arrives from JavaScript, and the honest answer is that we read it and there was
      // nothing there — which is the owner's to act on, so it says so.
      //
      // An address we already have is marked failed instead, exactly as «Обновить» does: its
      // note stays, and the row has to stop claiming a success that this attempt was not.
      if (page.markdown.trim() === '') {
        if (existing) await markFailed(existing.id, req.agent!.id, NOTHING_TO_SAVE);
        throw new ApiError(400, NOTHING_TO_SAVE);
      }

      if (existing) return applyReimport(req.agent!.id, existing, page);

      return db.transaction(async (tx) => {
        const [created] = await tx
          .insert(kbSources)
          .values({
            kind: 'page',
            title: page.title,
            url,
            agentId: req.agent!.id,
            status: 'ready',
            itemCount: 1,
            importedAt: new Date(),
          })
          .returning();

        const note = await saveNoteAtUniquePath(tx, req.agent!.id, 'С сайта', page.title, {
          body: page.markdown,
          sourceId: created!.id,
        });

        return {
          source: toKbSource(created!),
          notes: [toKbNote(note, created!.title)],
          reimported: false,
          keptEdited: 0,
        };
      });
    },
  );

  app.post(
    '/api/agents/:agentId/knowledge/sources/:sourceId/reimport',
    { preHandler: [guard, ownerOnly] },
    async (req, reply): Promise<KbImport> => {
      const { sourceId } = req.params as { sourceId: string };
      const source = await loadSource(req.agent!.id, sourceId);
      if (source.kind !== 'page' || !source.url) {
        throw new ApiError(400, 'Обновить можно только импорт страницы');
      }
      // The address the owner gave us, read again exactly as it was the first time. It will
      // redirect again if it redirected before, which is the point: a redirect is a standing
      // instruction of the site's, not a fact about the page we get to record once.
      const url = source.url;

      // Fetched before anything is deleted, and outside the transaction: a site that is
      // down for an hour must not empty the knowledge base while it is.
      let page: PageMarkdown;
      try {
        page = await fetchPage(url, pageFetcher);
      } catch (error) {
        await markFailed(source.id, req.agent!.id, PAGE_REFUSED);
        app.log.warn({ url, detail: failureDetail(error) }, 'knowledge page reimport failed');
        // Answered with the full body, not thrown: a first import has no source to show for a
        // failure, but a refresh does, and its new `status` — read back here, not assumed — is
        // the answer the owner's screen redraws from. But the status code still has to say
        // this refresh did not work — `import/page` throws 502 for the identical failure, and
        // the screen treats any non-throwing response as success, so a 200 here would tell the
        // owner the page updated when it did not. `reply.code` rather than `ApiError`, whose
        // global handler flattens the body to `{message}` and would lose the source and notes
        // this response exists to carry.
        reply.code(502);
        return failedReimport(req.agent!.id, source.id);
      }

      // Marked failed before answering, exactly as a failed fetch is. The note stays — it is
      // still the best answer we have — but leaving the source `ready` with the `itemCount`
      // of the previous import would have it claim a success that did not happen, and the
      // owner would have no idea the page had stopped yielding anything.
      if (page.markdown.trim() === '') {
        await markFailed(source.id, req.agent!.id, NOTHING_TO_SAVE);
        throw new ApiError(400, NOTHING_TO_SAVE);
      }

      return applyReimport(req.agent!.id, source, page);
    },
  );

  app.delete(
    '/api/agents/:agentId/knowledge/sources/:sourceId',
    { preHandler: [guard, ownerOnly] },
    async (req): Promise<{ ok: true }> => {
      const { sourceId } = req.params as { sourceId: string };
      const source = await loadSource(req.agent!.id, sourceId);

      // Only the source row goes. Its notes stay, with `sourceId` set to null by the
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
