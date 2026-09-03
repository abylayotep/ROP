import type { KbItem, KbSource } from '@rakurs/contract';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { kbItems, kbSources } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import { kbItemColumns, searchKnowledge, type KbRow } from '../lib/knowledge/search.js';
import { isUuid } from '../lib/uuid.js';
import { requireAgent } from './require-agent.js';

const KINDS = ['product', 'qa', 'procedure', 'contact', 'other'] as const;

/** pleep's own limits, and they are the right shape: a fact, not an essay. */
const TITLE_MAX = 200;
const CONTENT_MAX = 8000;
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

export function registerKnowledgeRoutes(
  app: FastifyInstance,
  db: Db,
  guard: preHandlerHookHandler,
): void {
  // Any member: an operator who watches the agent give a wrong answer is the fastest way
  // it gets corrected, and a lock would put a day between noticing and fixing.
  const anyMember = requireAgent(db);

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
}
