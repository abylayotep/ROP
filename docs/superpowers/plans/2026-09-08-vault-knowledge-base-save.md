# Vault Knowledge Base — Part 2: saving and search

> Part of [the vault plan](2026-09-08-vault-knowledge-base.md). Read its header and **Global Constraints** before starting, and use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to work through the tasks. Steps use checkbox (`- [ ]`) syntax.

**Spec:** [docs/superpowers/specs/2026-09-08-obsidian-knowledge-base-design.md](../specs/2026-09-08-obsidian-knowledge-base-design.md)

---

### Task 4: Saving a note

**Files:**
- Create: `server/src/lib/knowledge/notes.ts`
- Test: `server/test/knowledge-note-save.test.ts`

**Interfaces:**
- Consumes: `parseNote`, `parseLinks`, `kbNotes`, `kbChunks`, `kbLinks`.
- Produces:
  - `export async function saveNote(tx: Db, input: SaveNoteInput): Promise<KbNoteRow>` where `SaveNoteInput = { agentId: string; noteId?: string; path: string; body: string; sourceId?: string | null; edited?: boolean }`
  - `export async function deleteNote(tx: Db, agentId: string, noteId: string): Promise<void>`
  - `export function chunkTitle(noteTitle: string, heading: string, index: number, total: number): string`

- [ ] **Step 1: Write the failing test**

```ts
// server/test/knowledge-note-save.test.ts
import { asc, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { kbChunks, kbLinks, kbNotes } from '../src/db/schema.js';
import { deleteNote, saveNote } from '../src/lib/knowledge/notes.js';
import { createAccountWithOwner } from '../src/lib/provision.js';
import { withDb } from './helpers/db.js';

let db: Awaited<ReturnType<typeof withDb>>;
let agentId: string;

beforeEach(async () => {
  db = await withDb();
  ({ agentId } = await createAccountWithOwner(db, {
    company: 'Сафина', email: 'owner@example.com', password: 'correct-horse-battery',
  }));
});

const chunks = (noteId: string) =>
  db.select().from(kbChunks).where(eq(kbChunks.noteId, noteId)).orderBy(asc(kbChunks.ordinal));

describe('saveNote', () => {
  it('writes a chunk per section, titled note then heading', async () => {
    const note = await saveNote(db, {
      agentId, path: 'Доставка', body: '## По городу\n1500 ₸.\n\n## В Астану\n3000 ₸.',
    });
    expect((await chunks(note.id)).map((c) => c.title))
      .toEqual(['Доставка › По городу', 'Доставка › В Астану']);
  });

  it('titles a lead section by the note alone', async () => {
    const note = await saveNote(db, { agentId, path: 'Товары/Двери', body: 'Металл, 80 000 ₸.' });
    expect((await chunks(note.id))[0]!.title).toBe('Двери');
  });

  it('rebuilds chunks instead of appending them', async () => {
    const note = await saveNote(db, { agentId, path: 'Доставка', body: '## А\nОдин.' });
    await saveNote(db, { agentId, noteId: note.id, path: 'Доставка', body: '## Б\nДва.' });
    const rows = await chunks(note.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.heading).toBe('Б');
  });

  it('mirrors the frontmatter kind onto every chunk', async () => {
    const note = await saveNote(db, {
      agentId, path: 'Двери', body: '---\nkind: product\n---\n## А\nОдин.\n\n## Б\nДва.',
    });
    expect((await chunks(note.id)).every((c) => c.kind === 'product')).toBe(true);
  });

  it('numbers the pieces of a section too long for its column', async () => {
    const note = await saveNote(db, {
      agentId, path: 'Прайс', body: `## Цены\n${'а'.repeat(5000)}\n\n${'б'.repeat(5000)}`,
    });
    expect((await chunks(note.id)).map((c) => c.title))
      .toEqual(['Прайс › Цены (1)', 'Прайс › Цены (2)']);
  });

  it('resolves a link when its target already exists', async () => {
    await saveNote(db, { agentId, path: 'Гарантия', body: 'Год.' });
    const from = await saveNote(db, { agentId, path: 'Двери', body: 'Смотри [[Гарантия]].' });
    const [link] = await db.select().from(kbLinks).where(eq(kbLinks.fromNoteId, from.id));
    expect(link!.toNoteId).not.toBeNull();
  });

  it('resolves a broken link when the target is created later', async () => {
    const from = await saveNote(db, { agentId, path: 'Двери', body: '[[Гарантия]]' });
    const target = await saveNote(db, { agentId, path: 'Гарантия', body: 'Год.' });
    const [link] = await db.select().from(kbLinks).where(eq(kbLinks.fromNoteId, from.id));
    expect(link!.toNoteId).toBe(target.id);
  });

  it('breaks a link again when its target is deleted', async () => {
    const target = await saveNote(db, { agentId, path: 'Гарантия', body: 'Год.' });
    const from = await saveNote(db, { agentId, path: 'Двери', body: '[[Гарантия]]' });
    await deleteNote(db, agentId, target.id);
    const [link] = await db.select().from(kbLinks).where(eq(kbLinks.fromNoteId, from.id));
    expect(link!.toNoteId).toBeNull();
  });

  it('re-points links when a note is renamed', async () => {
    const target = await saveNote(db, { agentId, path: 'Гарантия', body: 'Год.' });
    const from = await saveNote(db, { agentId, path: 'Двери', body: '[[Гарантия на двери]]' });
    await saveNote(db, { agentId, noteId: target.id, path: 'Гарантия на двери', body: 'Год.' });
    const [link] = await db.select().from(kbLinks).where(eq(kbLinks.fromNoteId, from.id));
    expect(link!.toNoteId).toBe(target.id);
  });

  it('marks a note edited and moves updatedAt', async () => {
    const note = await saveNote(db, { agentId, path: 'Двери', body: 'Раз.' });
    const after = await saveNote(db, { agentId, noteId: note.id, path: 'Двери', body: 'Два.', edited: true });
    expect(after.edited).toBe(true);
    expect(after.updatedAt.getTime()).toBeGreaterThanOrEqual(note.updatedAt.getTime());
  });

  it('writes no chunk for a body with nothing in it', async () => {
    const note = await saveNote(db, { agentId, path: 'Пусто', body: '   ' });
    expect(await chunks(note.id)).toEqual([]);
    expect(await db.select().from(kbNotes).where(eq(kbNotes.id, note.id))).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/knowledge-note-save.test.ts`
Expected: FAIL — unresolved import.

- [ ] **Step 3: Write `notes.ts`**

```ts
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { kbChunks, kbLinks, kbNotes } from '../../db/schema.js';
import { parseLinks } from './links.js';
import { parseNote } from './note.js';
import { TITLE_MAX } from './split.js';

export interface SaveNoteInput {
  agentId: string;
  noteId?: string;
  path: string;
  body: string;
  sourceId?: string | null;
  edited?: boolean;
}

/** «Заметка › Раздел», numbered when one section became several pieces. */
export function chunkTitle(noteTitle: string, heading: string, index: number, total: number): string {
  const base = heading === '' ? noteTitle : `${noteTitle} › ${heading}`;
  const numbered = total > 1 ? `${base} (${index + 1})` : base;
  return numbered.length <= TITLE_MAX ? numbered : `${numbered.slice(0, TITLE_MAX - 1)}…`;
}

/** The last path segment. Folders are everything before it and are not stored anywhere. */
const titleOf = (path: string): string => path.split('/').pop()!.trim();

/**
 * Point every link in this agent at the note that now carries its title, and unpoint the ones
 * whose title nothing carries any more.
 *
 * Whole-agent rather than per-note: a note created, renamed or deleted changes the meaning of
 * links written in notes we are not touching, and resolving only the note in hand is what
 * would leave a link broken until somebody happened to re-save the note holding it.
 */
async function resolveLinks(tx: Db, agentId: string): Promise<void> {
  await tx.execute(sql`
    UPDATE kb_links l
    SET to_note_id = n.id
    FROM kb_notes n
    WHERE l.agent_id = ${agentId}
      AND n.agent_id = ${agentId}
      AND lower(n.title) = lower(l.target)
      AND l.to_note_id IS DISTINCT FROM n.id`);
  await tx.execute(sql`
    UPDATE kb_links l
    SET to_note_id = NULL
    WHERE l.agent_id = ${agentId}
      AND l.to_note_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM kb_notes n
        WHERE n.agent_id = ${agentId} AND n.id = l.to_note_id AND lower(n.title) = lower(l.target))`);
}

/**
 * Write a note and everything derived from it, in one transaction.
 *
 * The chunks are deleted and written again rather than diffed: a diff would have to decide
 * which old section a new one «is», and that guess is exactly what the page importer learned
 * not to make.
 */
export async function saveNote(tx: Db, input: SaveNoteInput): Promise<typeof kbNotes.$inferSelect> {
  const parsed = parseNote(input.body);
  const title = titleOf(input.path);
  const values = {
    agentId: input.agentId,
    path: input.path,
    title,
    body: input.body,
    kind: parsed.kind,
    tags: parsed.tags,
    sourceId: input.sourceId ?? null,
    ...(input.edited === undefined ? {} : { edited: input.edited }),
    updatedAt: new Date(),
  };

  const [note] = input.noteId
    ? await tx.update(kbNotes).set(values)
        .where(and(eq(kbNotes.id, input.noteId), eq(kbNotes.agentId, input.agentId))).returning()
    : await tx.insert(kbNotes).values(values).returning();
  if (!note) throw new Error('note not found');

  await tx.delete(kbChunks).where(eq(kbChunks.noteId, note.id));
  const byHeading = new Map<string, number>();
  for (const section of parsed.sections) {
    byHeading.set(section.heading, (byHeading.get(section.heading) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  const rows = parsed.sections.map((section, ordinal) => {
    const index = seen.get(section.heading) ?? 0;
    seen.set(section.heading, index + 1);
    return {
      agentId: input.agentId,
      noteId: note.id,
      ordinal,
      heading: section.heading,
      title: chunkTitle(title, section.heading, index, byHeading.get(section.heading)!),
      content: section.content,
      kind: parsed.kind,
    };
  });
  if (rows.length > 0) await tx.insert(kbChunks).values(rows);

  await tx.delete(kbLinks).where(eq(kbLinks.fromNoteId, note.id));
  const targets = parseLinks(input.body);
  if (targets.length > 0) {
    await tx.insert(kbLinks).values(
      targets.map((target) => ({ agentId: input.agentId, fromNoteId: note.id, target })),
    );
  }
  await resolveLinks(tx, input.agentId);
  return note;
}

/** Deleting a note takes its chunks and its outgoing links; links pointing at it go broken. */
export async function deleteNote(tx: Db, agentId: string, noteId: string): Promise<void> {
  await tx.delete(kbNotes).where(and(eq(kbNotes.id, noteId), eq(kbNotes.agentId, agentId)));
  await resolveLinks(tx, agentId);
}
```

Note for the implementer: `inArray` is imported for Task 8's reimport path and may be added there instead if the linter objects to an unused import now.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/knowledge-note-save.test.ts`
Expected: PASS, all twelve.

- [ ] **Step 5: Commit**

```bash
git add server/src/lib/knowledge/notes.ts server/test/knowledge-note-save.test.ts
git commit -m "Derive chunks and links from a note on every save"
```

---

### Task 5: Search over sections

**Files:**
- Modify: `server/src/lib/knowledge/search.ts`
- Modify: `server/test/knowledge-search.test.ts`

**Interfaces:**
- Produces: `KbRow = Omit<typeof kbChunks.$inferSelect, 'search'>` and `kbChunkColumns`, replacing `kbItemColumns`. `searchKnowledge(db, agentId, query, limit, options)` keeps its signature; `KnowledgeHit` becomes `{ chunk: KbRow; rank: number }`.

- [ ] **Step 1: Update the existing test to sections**

Rewrite `server/test/knowledge-search.test.ts` so its fixtures are notes saved with `saveNote` instead of inserted `kbItems`, and its assertions read `hit.chunk.title`. Keep every existing case — two-pass strict/loose, the hyphen rules, `kind` inside the query, the limit, Russian word forms — and add:

```ts
it('finds the section that answers, not the note that contains it', async () => {
  await saveNote(db, {
    agentId, path: 'Доставка',
    body: '## По городу\n1500 ₸.\n\n## Возврат\n14 дней, чек не нужен.',
  });
  const hits = await searchKnowledge(db, agentId, 'возврат чек', 20);
  expect(hits).toHaveLength(1);
  expect(hits[0]!.chunk.title).toBe('Доставка › Возврат');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/knowledge-search.test.ts`
Expected: FAIL — `saveNote` writes chunks, `searchKnowledge` still reads `kb_items`, so every case returns nothing.

- [ ] **Step 3: Move the search onto `kb_chunks`**

In `search.ts`: import `kbChunks` instead of `kbItems`; rename `kbItemColumns` to `kbChunkColumns` listing `id, agentId, noteId, ordinal, heading, title, content, kind, createdAt, updatedAt`; rename the `item` field of `KnowledgeHit` to `chunk`. The two passes, `normalizeQuery`, `TEXT_SEARCH_CONFIG` and every comment about them stay exactly as they are — this task moves a table, it does not change a ranker.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/knowledge-search.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/lib/knowledge/search.ts server/test/knowledge-search.test.ts
git commit -m "Rank sections instead of records"
```

---
