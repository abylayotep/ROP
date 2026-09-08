# Vault Knowledge Base — Part 1: the store

> Part of [the vault plan](2026-09-08-vault-knowledge-base.md). Read its header and **Global Constraints** before starting, and use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to work through the tasks. Steps use checkbox (`- [ ]`) syntax.

**Spec:** [docs/superpowers/specs/2026-09-08-obsidian-knowledge-base-design.md](../specs/2026-09-08-obsidian-knowledge-base-design.md)

---

### Task 1: Split a note into sections

**Files:**
- Create: `server/src/lib/knowledge/note.ts`
- Test: `server/test/knowledge-note-split.test.ts`

**Interfaces:**
- Consumes: `splitLongText` — extracted in this task from the private `cut` in `server/src/lib/knowledge/split.ts`, exported as `export function splitLongText(content: string): string[]`.
- Produces: `export interface NoteSection { heading: string; content: string }`, `export interface ParsedNote { kind: KbNoteKind; tags: string[]; sections: NoteSection[] }`, `export function parseNote(body: string): ParsedNote`, `export const BODY_MAX = 200_000`.

- [ ] **Step 1: Write the failing test**

```ts
// server/test/knowledge-note-split.test.ts
import { describe, expect, it } from 'vitest';
import { parseNote } from '../src/lib/knowledge/note.js';

const headings = (body: string) => parseNote(body).sections.map((s) => s.heading);

describe('parseNote', () => {
  it('starts a section at every heading level', () => {
    const parsed = parseNote('# Доставка\nПо городу.\n\n### Астана\n3000 ₸.');
    expect(parsed.sections).toEqual([
      { heading: 'Доставка', content: 'По городу.' },
      { heading: 'Астана', content: '3000 ₸.' },
    ]);
  });

  it('keeps the text before the first heading as a section with no heading', () => {
    expect(parseNote('Мы ставим двери.\n\n## Цены\n80 000 ₸.').sections[0]).toEqual({
      heading: '',
      content: 'Мы ставим двери.',
    });
  });

  it('drops a heading with nothing under it', () => {
    expect(headings('## Оглавление\n## Доставка\nПо городу.')).toEqual(['Доставка']);
  });

  it('does not read a hash inside a fenced block as a heading', () => {
    expect(headings('## Прайс\n```\n# 80 000 ₸\n```')).toEqual(['Прайс']);
  });

  it('reads frontmatter and removes it from the body', () => {
    const parsed = parseNote('---\nkind: product\ntags: [двери, металл]\n---\n\nЦена 80 000 ₸.');
    expect(parsed.kind).toBe('product');
    expect(parsed.tags).toEqual(['двери', 'металл']);
    expect(parsed.sections).toEqual([{ heading: '', content: 'Цена 80 000 ₸.' }]);
  });

  it('keeps an unparseable frontmatter block as text', () => {
    const parsed = parseNote('---\n: : :\n---\nЦена.');
    expect(parsed.kind).toBe('other');
    expect(parsed.sections[0]!.content.startsWith('---')).toBe(true);
  });

  it('cuts a section over the content limit on a paragraph boundary', () => {
    const body = `## Прайс\n${'а'.repeat(5000)}\n\n${'б'.repeat(5000)}`;
    const sections = parseNote(body).sections;
    expect(sections).toHaveLength(2);
    expect(sections.every((s) => s.content.length <= 8000)).toBe(true);
    expect(sections[1]!.content.startsWith('б')).toBe(true);
  });

  it('returns nothing for a body with no text in it', () => {
    expect(parseNote('   \n\n ').sections).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from `server/`: `npx vitest run test/knowledge-note-split.test.ts`
Expected: FAIL — `Failed to resolve import "../src/lib/knowledge/note.js"`.

- [ ] **Step 3: Export the long-text cutter from `split.ts`**

In `server/src/lib/knowledge/split.ts`, rename the private `cut` to `splitLongText` and export it; update the one caller in `toParts`. The JSDoc on it stays, and gains a sentence saying the note splitter shares it.

- [ ] **Step 4: Write `note.ts`**

```ts
import { CONTENT_MAX, splitLongText } from './split.js';

/** The five values a record's type had. Frontmatter carries it now; chunks mirror it. */
export type KbNoteKind = 'product' | 'qa' | 'procedure' | 'contact' | 'other';
const KINDS: readonly string[] = ['product', 'qa', 'procedure', 'contact', 'other'];

/** A body long enough to hold a price list, short enough that one save is one request. */
export const BODY_MAX = 200_000;

export interface NoteSection {
  heading: string;
  content: string;
}

export interface ParsedNote {
  kind: KbNoteKind;
  tags: string[];
  sections: NoteSection[];
}

const normalise = (text: string): string =>
  text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

/**
 * The two frontmatter keys we read, in the one shape we write.
 *
 * Not a YAML parser: a dependency that reads arbitrary YAML would read anchors and tags we
 * have no use for, and the failure mode of this function is «leave the block as text», which
 * shows the owner their own dashes rather than swallowing their first paragraph.
 */
function readFrontmatter(body: string): { kind: KbNoteKind; tags: string[]; rest: string } | null {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(body);
  if (!match) return null;

  let kind: KbNoteKind = 'other';
  const tags: string[] = [];
  for (const line of match[1]!.split('\n')) {
    const pair = /^([A-Za-z_]+):\s*(.*)$/.exec(line.trim());
    if (!pair) return null;
    const [, key, value] = pair;
    if (key === 'kind' && KINDS.includes(value!)) kind = value as KbNoteKind;
    else if (key === 'tags') {
      const list = value!.replace(/^\[|\]$/g, '');
      tags.push(...list.split(',').map((tag) => tag.trim()).filter((tag) => tag !== ''));
    }
  }
  return { kind, tags, rest: body.slice(match[0].length) };
}

/**
 * A note becomes the sections the agent retrieves.
 *
 * Flat, not nested: a `###` under a `##` is its own section, because the agent quotes what it
 * is handed and a nested section would carry its parent's text into every answer.
 */
export function parseNote(body: string): ParsedNote {
  const text = normalise(body);
  const front = readFrontmatter(text);
  const lines = (front?.rest ?? text).split('\n');

  const sections: NoteSection[] = [];
  let heading = '';
  let buffer: string[] = [];
  let fenced = false;

  const flush = () => {
    const content = buffer.join('\n').trim();
    buffer = [];
    if (content === '') return;
    // One section per piece when a section outgrows its column. The heading repeats: the
    // pieces are numbered in the chunk title, which is where a reader sees them.
    for (const piece of splitLongText(content)) sections.push({ heading, content: piece });
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    const found = fenced ? null : /^#{1,6}\s+(.*\S)\s*$/.exec(line);
    if (found) {
      flush();
      heading = found[1]!;
      continue;
    }
    buffer.push(line);
  }
  flush();

  return { kind: front?.kind ?? 'other', tags: front?.tags ?? [], sections };
}
```

Note for the implementer: `splitLongText` must return `[content]` unchanged when it is within `CONTENT_MAX`; that is already its behaviour.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/knowledge-note-split.test.ts test/knowledge-split.test.ts`
Expected: PASS — both files, the second proving the extraction did not change the importers.

- [ ] **Step 6: Commit**

```bash
git add server/src/lib/knowledge/note.ts server/src/lib/knowledge/split.ts server/test/knowledge-note-split.test.ts
git commit -m "Split a note into the sections the agent retrieves"
```

---

### Task 2: Parse wiki links

**Files:**
- Create: `server/src/lib/knowledge/links.ts`
- Test: `server/test/knowledge-links.test.ts`

**Interfaces:**
- Produces: `export function parseLinks(body: string): string[]` — the distinct link targets in a body, in the order they appear, trimmed, with the `|label` half dropped.

- [ ] **Step 1: Write the failing test**

```ts
// server/test/knowledge-links.test.ts
import { describe, expect, it } from 'vitest';
import { parseLinks } from '../src/lib/knowledge/links.js';

describe('parseLinks', () => {
  it('finds a plain link', () => {
    expect(parseLinks('Смотри [[Доставка]] и [[Гарантия]].')).toEqual(['Доставка', 'Гарантия']);
  });

  it('drops the label half', () => {
    expect(parseLinks('[[Доставка|как везём]]')).toEqual(['Доставка']);
  });

  it('returns each target once', () => {
    expect(parseLinks('[[Доставка]] и снова [[доставка]]')).toEqual(['Доставка']);
  });

  it('ignores a link inside a fenced block', () => {
    expect(parseLinks('```\n[[Доставка]]\n```\n[[Гарантия]]')).toEqual(['Гарантия']);
  });

  it('ignores an empty or whitespace target', () => {
    expect(parseLinks('[[]] [[   ]]')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/knowledge-links.test.ts`
Expected: FAIL — unresolved import.

- [ ] **Step 3: Write `links.ts`**

```ts
/**
 * The `[[targets]]` a body points at, once each, in the order they were written.
 *
 * Case-insensitively deduplicated and resolved the same way, because a note title is a name a
 * person typed twice and expects to be the same name both times. The first spelling wins, so
 * a broken link reads back the way its author wrote it.
 */
export function parseLinks(body: string): string[] {
  const withoutFences = body.replace(/```[\s\S]*?(```|$)/g, '');
  const found = new Map<string, string>();
  for (const match of withoutFences.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) {
    const target = match[1]!.trim();
    if (target === '') continue;
    const key = target.toLocaleLowerCase('ru');
    if (!found.has(key)) found.set(key, target);
  }
  return [...found.values()];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/knowledge-links.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/lib/knowledge/links.ts server/test/knowledge-links.test.ts
git commit -m "Parse the wiki links a note body carries"
```

---

### Task 3: Schema and migration 0012

**Files:**
- Modify: `server/src/db/schema.ts` (replace `kbItems` with `kbNotes`, `kbChunks`, `kbLinks`)
- Modify: `server/test/helpers/db.ts:19-21` (truncate list)
- Create: `server/drizzle/0012_*.sql` (generated, then hand-edited)
- Test: `server/test/knowledge-vault-schema.test.ts`

**Interfaces:**
- Produces: `kbNotes`, `kbChunks`, `kbLinks` table objects; `KbNoteRow = typeof kbNotes.$inferSelect`.

- [ ] **Step 1: Write the failing test**

```ts
// server/test/knowledge-vault-schema.test.ts
import { and, eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { kbChunks, kbLinks, kbNotes } from '../src/db/schema.js';
import { createAccountWithOwner } from '../src/lib/provision.js';
import { withDb } from './helpers/db.js';

let db: Awaited<ReturnType<typeof withDb>>;
let agentId: string;

beforeEach(async () => {
  db = await withDb();
  const { agentId: id } = await createAccountWithOwner(db, {
    company: 'Сафина',
    email: 'owner@example.com',
    password: 'correct-horse-battery',
  });
  agentId = id;
});

const note = (path: string) =>
  db.insert(kbNotes).values({ agentId, path, title: path.split('/').pop()!, body: '' }).returning();

describe('the vault schema', () => {
  it('refuses two notes at one path in one agent', async () => {
    await note('Товары/Двери');
    await expect(note('Товары/Двери')).rejects.toThrow();
  });

  it('indexes a chunk for Russian word forms', async () => {
    const [row] = await note('Доставка');
    await db.insert(kbChunks).values({
      agentId, noteId: row!.id, ordinal: 0, heading: 'По городу',
      title: 'Доставка › По городу', content: 'Двери возим по Алматы за 1500 ₸.', kind: 'other',
    });
    const hits = await db
      .select({ id: kbChunks.id })
      .from(kbChunks)
      .where(and(eq(kbChunks.agentId, agentId),
        sql`${kbChunks.search} @@ websearch_to_tsquery('russian', 'дверей')`));
    expect(hits).toHaveLength(1);
  });

  it('takes a link with no target and keeps it when the note goes', async () => {
    const [from] = await note('Двери');
    await db.insert(kbLinks).values({ agentId, fromNoteId: from!.id, target: 'Гарантия' });
    const [link] = await db.select().from(kbLinks).where(eq(kbLinks.fromNoteId, from!.id));
    expect(link!.toNoteId).toBeNull();
  });

  it('deletes a note`s chunks with it', async () => {
    const [row] = await note('Двери');
    await db.insert(kbChunks).values({
      agentId, noteId: row!.id, ordinal: 0, heading: '', title: 'Двери',
      content: 'Металл.', kind: 'other',
    });
    await db.delete(kbNotes).where(eq(kbNotes.id, row!.id));
    expect(await db.select().from(kbChunks)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/knowledge-vault-schema.test.ts`
Expected: FAIL — `kbNotes` is not exported from the schema.

- [ ] **Step 3: Write the tables**

In `server/src/db/schema.ts`, delete `kbItems` and add, keeping `kbSources` where it is:

```ts
/**
 * One note: what a person writes and reads. `path` is its identity — «Товары/Двери входные» —
 * and folders are the segments before the last slash rather than a table, exactly as a folder
 * in a vault exists because a file is in it.
 */
export const kbNotes = pgTable(
  'kb_notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
    // Set null, not cascade: deleting an import must not delete the notes it produced.
    sourceId: uuid('source_id').references(() => kbSources.id, { onDelete: 'set null' }),
    path: text('path').notNull(),
    // The last path segment, stored so search can weight it without parsing the path.
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    // 'product' | 'qa' | 'procedure' | 'contact' | 'other', read out of the frontmatter.
    kind: text('kind').notNull().default('other'),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    // True once a person has changed it. A reimport replaces what it made, except these.
    edited: boolean('edited').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('kb_notes_agent_path_key').on(t.agentId, t.path),
          index('kb_notes_agent_updated_idx').on(t.agentId, t.updatedAt)],
);

/**
 * One section of a note: the unit search ranks and the agent quotes.
 *
 * Derived and disposable. Every save deletes a note's rows here and writes them again, so
 * nothing but `saveNote` may insert one and nothing may read a note's text out of one.
 */
export const kbChunks = pgTable(
  'kb_chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
    noteId: uuid('note_id').notNull().references(() => kbNotes.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    heading: text('heading').notNull().default(''),
    // «Заметка › Раздел», or the note title for the lead section. Stored, not composed at
    // read time: it is what the tsvector weights, and a composed value cannot be indexed.
    title: text('title').notNull(),
    content: text('content').notNull(),
    kind: text('kind').notNull().default('other'),
    search: tsvector('search').notNull().generatedAlwaysAs(
      sql`setweight(to_tsvector('russian', coalesce(title, '')), 'A') || setweight(to_tsvector('russian', coalesce(content, '')), 'B')`,
    ),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('kb_chunks_agent_kind_idx').on(t.agentId, t.kind),
          index('kb_chunks_search_idx').using('gin', t.search),
          index('kb_chunks_note_ordinal_idx').on(t.noteId, t.ordinal)],
);

/**
 * One `[[link]]`. `toNoteId` is null while the target does not exist: a link written before
 * its note is a broken link the vault shows as one, not a reason to refuse the text.
 */
export const kbLinks = pgTable(
  'kb_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
    fromNoteId: uuid('from_note_id').notNull().references(() => kbNotes.id, { onDelete: 'cascade' }),
    toNoteId: uuid('to_note_id').references(() => kbNotes.id, { onDelete: 'set null' }),
    target: text('target').notNull(),
  },
  (t) => [index('kb_links_agent_target_idx').on(t.agentId, t.toNoteId),
          index('kb_links_from_idx').on(t.fromNoteId)],
);
```

- [ ] **Step 4: Generate the migration and add the data move**

Run from `server/`: `npm run generate`. Open the new `drizzle/0012_*.sql`. It will create the three tables and drop `kb_items`. Move the `DROP TABLE kb_items` to the end and insert before it:

```sql
--> statement-breakpoint
-- Every record becomes one note in the folder its kind named, and one section.
INSERT INTO kb_notes (id, agent_id, source_id, path, title, body, kind, edited, created_at, updated_at)
SELECT i.id, i.agent_id, i.source_id,
       CASE i.kind
         WHEN 'product'   THEN 'Товары/'
         WHEN 'qa'        THEN 'Вопросы-ответы/'
         WHEN 'procedure' THEN 'Процедуры/'
         WHEN 'contact'   THEN 'Контакты/'
         ELSE 'Прочее/'
       END || replace(i.title, '/', '∕')
       -- A title colliding inside its folder gets its ordinal, so no record is lost to the
       -- unique index. Ordered by creation so the oldest keeps the bare name.
       || CASE WHEN row_number() OVER (
              PARTITION BY i.agent_id, i.kind, replace(i.title, '/', '∕')
              ORDER BY i.created_at, i.id) = 1
          THEN '' ELSE ' (' || row_number() OVER (
              PARTITION BY i.agent_id, i.kind, replace(i.title, '/', '∕')
              ORDER BY i.created_at, i.id) || ')' END,
       i.title, i.content, i.kind, i.edited, i.created_at, i.updated_at
FROM kb_items i;
--> statement-breakpoint
INSERT INTO kb_chunks (agent_id, note_id, ordinal, heading, title, content, kind, created_at, updated_at)
SELECT n.agent_id, n.id, 0, '', n.title, n.body, n.kind, n.created_at, n.updated_at
FROM kb_notes n;
```

- [ ] **Step 5: Add the tables to the test truncate list**

In `server/test/helpers/db.ts`, replace `kb_items` with `kb_links, kb_chunks, kb_notes` in the `truncate` statement.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/knowledge-vault-schema.test.ts test/schema.test.ts test/db.test.ts`
Expected: PASS. If `schema.test.ts` asserts on `kb_items`, update those assertions to the new tables in the same commit.

- [ ] **Step 7: Commit**

```bash
git add server/src/db/schema.ts server/drizzle server/test/helpers/db.ts server/test/knowledge-vault-schema.test.ts server/test/schema.test.ts
git commit -m "Store the knowledge base as notes, sections and links"
```

---

