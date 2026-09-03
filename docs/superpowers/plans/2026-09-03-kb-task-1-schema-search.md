### Task 1: Schema, the generated index, and search

**Files:**
- Modify: `server/src/db/schema.ts` (append after `notes`, before `whatsappEvents`)
- Modify: `server/test/helpers/db.ts` (the `truncate` list)
- Create: `server/drizzle/0006_*.sql` (see step 4 — this one is likely hand-written)
- Create: `server/src/lib/knowledge/search.ts`
- Create: `server/test/knowledge-search.test.ts`

**Interfaces:**
- Consumes: `agents` from the schema.
- Produces: the tables `kbSources` and `kbItems`; `searchKnowledge(db, agentId, query, limit)` and the constant `TEXT_SEARCH_CONFIG` from `server/src/lib/knowledge/search.ts`.

**Context.** The store the agent will answer from. One row is one retrievable answer; Postgres generates the searchable vector so an item edited through any path is indexed by definition; and every read goes through one function so stage 5 can add a second ranker behind it.

- [ ] **Step 1: Write the failing test**

Create `server/test/knowledge-search.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { accounts, agents, kbItems, kbSources } from '../src/db/schema.js';
import { searchKnowledge } from '../src/lib/knowledge/search.js';
import { withDb } from './helpers/db.js';

type Db = Awaited<ReturnType<typeof withDb>>;

async function seedAgent(db: Db, name = 'Сафина') {
  const [account] = await db.insert(accounts).values({ name }).returning();
  const [agent] = await db.insert(agents).values({ accountId: account!.id, name }).returning();
  return agent!.id;
}

const item = (agentId: string, title: string, content: string, kind = 'other') => ({
  agentId,
  kind,
  title,
  content,
});

describe('searchKnowledge', () => {
  it('finds an item by a word from its content', async () => {
    const db = await withDb();
    const agentId = await seedAgent(db);
    await db.insert(kbItems).values([
      item(agentId, 'Доставка', 'Возим по Алматы бесплатно, в Астану за 3000 тенге.'),
      item(agentId, 'Гарантия', 'На все двери двенадцать месяцев.'),
    ]);

    const hits = await searchKnowledge(db, agentId, 'Астана', 10);

    expect(hits).toHaveLength(1);
    expect(hits[0]?.item.title).toBe('Доставка');
    expect(hits[0]?.rank).toBeGreaterThan(0);
  });

  it('finds a word in a form it was not written in', async () => {
    const db = await withDb();
    const agentId = await seedAgent(db);
    await db.insert(kbItems).values(item(agentId, 'Двери', 'Продаём межкомнатные двери.'));

    // The russian configuration stems: «дверей» and «двери» share a lexeme, and an
    // english configuration would treat them as two unrelated words.
    const hits = await searchKnowledge(db, agentId, 'дверей', 10);

    expect(hits).toHaveLength(1);
  });

  it('finds an item by its title', async () => {
    const db = await withDb();
    const agentId = await seedAgent(db);
    await db.insert(kbItems).values(item(agentId, 'Рассрочка', 'Через Kaspi Red.'));

    expect(await searchKnowledge(db, agentId, 'рассрочка', 10)).toHaveLength(1);
  });

  it('returns nothing when nothing matches', async () => {
    const db = await withDb();
    const agentId = await seedAgent(db);
    await db.insert(kbItems).values(item(agentId, 'Доставка', 'Возим по Алматы.'));

    // An empty answer is the point: stage 5's agent is meant to say it cannot answer
    // rather than invent, and this is how it learns that.
    expect(await searchKnowledge(db, agentId, 'вертолёт', 10)).toEqual([]);
  });

  it('returns nothing for a blank query rather than everything', async () => {
    const db = await withDb();
    const agentId = await seedAgent(db);
    await db.insert(kbItems).values(item(agentId, 'Доставка', 'Возим по Алматы.'));

    expect(await searchKnowledge(db, agentId, '   ', 10)).toEqual([]);
    expect(await searchKnowledge(db, agentId, '', 10)).toEqual([]);
  });

  it('never crosses into another agent', async () => {
    const db = await withDb();
    const ours = await seedAgent(db, 'Сафина');
    const theirs = await seedAgent(db, 'Другая');
    await db.insert(kbItems).values(item(theirs, 'Доставка', 'Возим по Алматы.'));

    expect(await searchKnowledge(db, ours, 'Алматы', 10)).toEqual([]);
  });

  it('survives a query full of punctuation', async () => {
    const db = await withDb();
    const agentId = await seedAgent(db);
    await db.insert(kbItems).values(item(agentId, 'Доставка', 'Возим по Алматы.'));

    // websearch_to_tsquery never raises on operators a person typed by accident,
    // which is the whole reason it is used instead of to_tsquery.
    for (const query of ['!!!', 'а & | б', '"незакрытая кавычка', '<->']) {
      await expect(searchKnowledge(db, agentId, query, 10)).resolves.toBeInstanceOf(Array);
    }
  });

  it('ranks a better match first and honours the limit', async () => {
    const db = await withDb();
    const agentId = await seedAgent(db);
    await db.insert(kbItems).values([
      item(agentId, 'Доставка в Астану', 'Доставка в Астану занимает два дня.'),
      item(agentId, 'Гарантия', 'Гарантия действует по всему Казахстану, включая Астану.'),
      item(agentId, 'Оплата', 'Оплата картой или наличными в Астане.'),
    ]);

    const hits = await searchKnowledge(db, agentId, 'доставка в Астану', 2);

    expect(hits).toHaveLength(2);
    expect(hits[0]?.item.title).toBe('Доставка в Астану');
  });

  it('keeps an item when the source it came from is deleted', async () => {
    const db = await withDb();
    const agentId = await seedAgent(db);
    const [source] = await db
      .insert(kbSources)
      .values({ agentId, kind: 'text', title: 'Прайс', status: 'ready' })
      .returning();
    await db.insert(kbItems).values({ ...item(agentId, 'Двери', 'От 90 000 тенге.'), sourceId: source!.id });

    await db.delete(kbSources).where(eq(kbSources.id, source!.id));

    const rows = await db.select().from(kbItems);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sourceId).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm --prefix server test -- knowledge-search
```

Expected: the file does not compile — the tables and the module do not exist.

- [ ] **Step 3: Add the tables**

In `server/src/db/schema.ts`, add `customType` to the import from `drizzle-orm/pg-core` and
`sql` from `drizzle-orm`, then append after `notes`:

```ts
/**
 * Postgres's own search vector. Declared as a custom type because Drizzle has no `tsvector`,
 * and never written from here — the column is generated, so an item edited through any path
 * is indexed correctly by definition rather than by remembering to reindex it.
 */
const tsvector = customType<{ data: string; notNull: true }>({
  dataType: () => 'tsvector',
});

/**
 * An import: a block of text someone pasted, or a page we fetched.
 *
 * It exists so that a reimport can replace what it made. An item written by hand has no
 * source, which is why `kb_items.source_id` is nullable.
 */
export const kbSources = pgTable(
  'kb_sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    // 'text' | 'page'
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    url: text('url'),
    // 'pending' | 'ready' | 'failed'
    status: text('status').notNull().default('pending'),
    // Why it failed, in the operator's language.
    error: text('error'),
    itemCount: integer('item_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    importedAt: timestamp('imported_at', { withTimezone: true }),
  },
  (t) => [index('kb_sources_agent_created_idx').on(t.agentId, t.createdAt)],
);

/**
 * One retrievable answer.
 *
 * A hand-written fact and a chunk of an imported page are the same thing to the agent, so
 * they are the same row. Two tables would mean two search paths and two ways to be stale.
 */
export const kbItems = pgTable(
  'kb_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    // Set null, not cascade: deleting an import must not delete the corrections someone
    // made to what it produced.
    sourceId: uuid('source_id').references(() => kbSources.id, { onDelete: 'set null' }),
    // 'product' | 'qa' | 'procedure' | 'contact' | 'other'
    kind: text('kind').notNull().default('other'),
    title: text('title').notNull(),
    content: text('content').notNull(),
    // True once a person has changed it. A reimport replaces what it made, except these:
    // a price the owner corrected by hand outranks the page it came from.
    edited: boolean('edited').notNull().default(false),
    search: tsvector('search')
      .notNull()
      .generatedAlwaysAs(
        sql`setweight(to_tsvector('russian', coalesce(title, '')), 'A') || setweight(to_tsvector('russian', coalesce(content, '')), 'B')`,
      ),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('kb_items_agent_kind_idx').on(t.agentId, t.kind),
    index('kb_items_search_idx').using('gin', t.search),
  ],
);
```

- [ ] **Step 4: Get the migration right**

Run `npm --prefix server run generate` and READ the SQL it produced. Three things can go
wrong and you must check all three:

1. The `search` column must be `GENERATED ALWAYS AS (...) STORED`, with the expression
   exactly as written above.
2. The generated expression's functions must be marked immutable for Postgres to accept
   them — `to_tsvector('russian', …)` with a literal configuration is immutable;
   `to_tsvector(…)` with a column or a default configuration is not and Postgres will
   refuse the column. If the generator drops the `'russian'` literal, the migration will
   fail on apply.
3. The index on `search` must be `USING gin`.

If drizzle-kit produces any of those wrongly, hand-write the migration instead: create it
with drizzle-kit's empty-migration command so the journal and the snapshot stay consistent,
write the two `CREATE TABLE` statements and the three indexes yourself, and say in your
report that you did and why. `server/drizzle/0005_seed_default_funnel.sql` is a hand-written
migration already in this repository — follow how it is registered.

Whichever path you take, apply it and prove the generated column works: after the tests
pass, the search test that matches a stemmed form is the proof.

- [ ] **Step 5: Extend the truncate list**

In `server/test/helpers/db.ts`, add `kb_items, kb_sources` to the `truncate` statement,
before `agents`.

- [ ] **Step 6: Write the search**

Create `server/src/lib/knowledge/search.ts`:

```ts
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { kbItems } from '../../db/schema.js';

/**
 * Russian, not the default.
 *
 * It stems and folds case, so «дверей» finds an item that says «двери». It does not stem
 * Kazakh — a Kazakh-language store will match on exact words, which is a real limit and
 * still better than the english configuration, which stems neither.
 *
 * Written once: the generated column in the schema and this query must agree, and two
 * literals that have to match are one edit away from not matching.
 */
export const TEXT_SEARCH_CONFIG = 'russian';

export interface KnowledgeHit {
  item: typeof kbItems.$inferSelect;
  rank: number;
}

/**
 * The only way anything reads the knowledge base.
 *
 * One signature so stage 5 can add an embedding column and a second ranker behind it
 * without touching a route or a screen.
 *
 * `websearch_to_tsquery` rather than `to_tsquery`: a person typing into a search box will
 * eventually type an unbalanced quote or a bare `&`, and `to_tsquery` raises on those.
 */
export async function searchKnowledge(
  db: Db,
  agentId: string,
  query: string,
  limit: number,
): Promise<KnowledgeHit[]> {
  const text = query.trim();
  // A blank query matches everything in tsquery terms, which would hand the agent the whole
  // store as though it were relevant. Nothing is the honest answer.
  if (text === '') return [];

  const tsquery = sql`websearch_to_tsquery(${TEXT_SEARCH_CONFIG}, ${text})`;
  const rank = sql<number>`ts_rank_cd(${kbItems.search}, ${tsquery})`;

  const rows = await db
    .select({ item: kbItems, rank })
    .from(kbItems)
    .where(and(eq(kbItems.agentId, agentId), sql`${kbItems.search} @@ ${tsquery}`))
    .orderBy(desc(rank))
    .limit(limit);

  return rows.map(({ item, rank: value }) => ({ item, rank: Number(value) }));
}
```

- [ ] **Step 7: Run the tests**

```bash
npm --prefix server test
npm --prefix server run typecheck
```

Expected: green, including every file that was already there.

- [ ] **Step 8: Commit**

```bash
git add server/src/db/schema.ts server/src/lib/knowledge server/drizzle server/test
git commit -m "Add the knowledge store and its Russian text search"
```
