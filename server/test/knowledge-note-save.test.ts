import { asc, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client.js';
import { accounts, agents, kbChunks, kbLinks, kbNotes } from '../src/db/schema.js';
import { deleteNote, saveNote } from '../src/lib/knowledge/notes.js';
import { withDb } from './helpers/db.js';

// createAccountWithOwner does not return { agentId } and takes more arguments than a
// note-save test needs; a direct insert (as in knowledge-vault-schema.test.ts) is the
// established pattern for tests that just need an agent to hang notes off of.
async function seedAgent(db: Db, name = 'Сафина'): Promise<string> {
  const [account] = await db.insert(accounts).values({ name }).returning();
  const [agent] = await db.insert(agents).values({ accountId: account!.id, name }).returning();
  return agent!.id;
}

let db: Db;
let agentId: string;

beforeEach(async () => {
  db = await withDb();
  agentId = await seedAgent(db);
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
