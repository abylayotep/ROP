### Task 2: Items over the API

**Files:**
- Create: `server/src/api/knowledge.ts`
- Modify: `server/src/api/server.ts` (register the routes)
- Modify: `packages/contract/index.ts` (the knowledge types)
- Create: `server/test/knowledge-api.test.ts` (its contents are in [task-2-items-test.md](2026-09-03-kb-task-2-items-test.md))

**Interfaces:**
- Consumes: `requireAgent`, `ApiError`, `isUuid`, `searchKnowledge` from task 1, the tables `kbItems` and `kbSources`.
- Produces: `registerKnowledgeRoutes(app, db, guard)`, the exported `toKbItem(row, sourceTitle)`, and:
  - `GET /api/agents/:agentId/knowledge/items` → `KbItem[]`, any member, query `kind` and `q`
  - `POST /api/agents/:agentId/knowledge/items` → `KbItem`, any member
  - `PATCH /api/agents/:agentId/knowledge/items/:itemId` → `KbItem`, any member
  - `DELETE /api/agents/:agentId/knowledge/items/:itemId` → `{ ok: true }`, any member
  - `GET /api/agents/:agentId/knowledge/sources` → `KbSource[]`, any member
- Tasks 3 and 4 add the import routes to this same file.

**Context.** Reading and writing the store by hand. Open to any member on purpose: an operator who sees the agent give a wrong answer is the fastest way it gets corrected, and a lock would put a day between noticing and fixing.

**Search and list are one route.** With `q` the list is ranked by relevance and returns only matches; without it, the newest first. Two routes would mean the screen's search box hits a different code path from the one stage 5's agent uses, and the owner would be testing something other than what the agent sees.

**`edited`.** A PATCH sets it to true. That is the whole mechanism task 4's reimport depends on, and it belongs here, where the edit happens.

- [ ] **Step 1: Extend the contract**

Append to `packages/contract/index.ts`:

```ts
/* ── База знаний ────────────────────────────────────────────────────────────
 * What the agent answers from. One row is one retrievable answer. */

export type KbItemKind = 'product' | 'qa' | 'procedure' | 'contact' | 'other';

export interface KbItem {
  id: string;
  kind: KbItemKind;
  title: string;
  content: string;
  /** True once a person has changed it. A reimport keeps these and replaces the rest. */
  edited: boolean;
  sourceId: string | null;
  /** The import this came from, for the screen. Null for a hand-written item. */
  sourceTitle: string | null;
  updatedAt: string;
}

export type KbSourceKind = 'text' | 'page';

export interface KbSource {
  id: string;
  kind: KbSourceKind;
  title: string;
  url: string | null;
  status: 'pending' | 'ready' | 'failed';
  /** Why it failed, in the operator's language. Null when it did not. */
  error: string | null;
  itemCount: number;
  createdAt: string;
}
```

- [ ] **Step 2: Write the failing test**

The test is long enough to live in its own document:
[task-2-items-test.md](2026-09-03-kb-task-2-items-test.md). Create
`server/test/knowledge-api.test.ts` with exactly the contents given there.

- [ ] **Step 3: Run it and watch it fail**

```bash
npm --prefix server test -- knowledge-api
```

Expected: every case fails with 404 — no route is registered yet.

- [ ] **Step 4: Write the routes**

Create `server/src/api/knowledge.ts`:

```ts
import type { KbItem, KbSource } from '@rakurs/contract';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { kbItems, kbSources } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import { searchKnowledge } from '../lib/knowledge/search.js';
import { isUuid } from '../lib/uuid.js';
import { requireAgent } from './require-agent.js';

const KINDS = ['product', 'qa', 'procedure', 'contact', 'other'] as const;

/** pleep's own limits, and they are the right shape: a fact, not an essay. */
const TITLE_MAX = 200;
const CONTENT_MAX = 8000;
/** A search nobody scrolls past. Stage 5 asks for far fewer. */
const SEARCH_LIMIT = 20;

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

export const toKbItem = (
  row: typeof kbItems.$inferSelect,
  sourceTitle: string | null,
): KbItem => ({
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
      .select()
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
      if (!parsed.success) throw new ApiError(400, 'Не удалось разобрать фильтр');
      const { kind, q } = parsed.data;
      const titles = await sourceTitles(req.agent!.id);

      // With a query the list IS the search: the owner's box and stage 5's agent must go
      // through the same ranker, or the owner is testing something the agent never sees.
      if (q !== undefined && q.trim() !== '') {
        const hits = await searchKnowledge(db, req.agent!.id, q, SEARCH_LIMIT);
        return hits
          .filter((hit) => kind === undefined || hit.item.kind === kind)
          .map((hit) => toKbItem(hit.item, titles.get(hit.item.sourceId ?? '') ?? null));
      }

      const rows = await db
        .select()
        .from(kbItems)
        .where(
          kind === undefined
            ? eq(kbItems.agentId, req.agent!.id)
            : and(eq(kbItems.agentId, req.agent!.id), eq(kbItems.kind, kind)),
        )
        .orderBy(desc(kbItems.updatedAt));
      return rows.map((row) => toKbItem(row, titles.get(row.sourceId ?? '') ?? null));
    },
  );

  app.post(
    '/api/agents/:agentId/knowledge/items',
    { preHandler: [guard, anyMember] },
    async (req): Promise<KbItem> => {
      const parsed = createItem.safeParse(req.body);
      if (!parsed.success) {
        throw new ApiError(400, `Заголовок до ${TITLE_MAX} символов, текст до ${CONTENT_MAX}`);
      }

      const [row] = await db
        .insert(kbItems)
        .values({ agentId: req.agent!.id, ...parsed.data })
        .returning();
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
      if (!parsed.success) {
        throw new ApiError(400, `Заголовок до ${TITLE_MAX} символов, текст до ${CONTENT_MAX}`);
      }

      const titles = await sourceTitles(req.agent!.id);
      if (Object.keys(parsed.data).length === 0) {
        return toKbItem(current, titles.get(current.sourceId ?? '') ?? null);
      }

      const [row] = await db
        .update(kbItems)
        // `edited` is set here and only here. It is what a reimport reads to decide what
        // it may replace: a price the owner corrected outranks the page it came from.
        .set({ ...parsed.data, edited: true, updatedAt: new Date() })
        .where(and(eq(kbItems.id, current.id), eq(kbItems.agentId, req.agent!.id)))
        .returning();
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
```

- [ ] **Step 5: Register the routes**

In `server/src/api/server.ts`, add the import and the registration after
`registerBoardRoutes(...)`:

```ts
import { registerKnowledgeRoutes } from './knowledge.js';
```

```ts
  registerKnowledgeRoutes(app, db, guard);
```

- [ ] **Step 6: Run the tests**

```bash
npm --prefix server test
npm --prefix server run typecheck
npm --prefix rakurs run typecheck
```

- [ ] **Step 7: Commit**

```bash
git add server/src/api packages/contract/index.ts server/test/knowledge-api.test.ts
git commit -m "Read and write the knowledge base over the API"
```
