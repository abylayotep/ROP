import { and, eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client.js';
import { accounts, agents, kbChunks, kbLinks, kbNotes } from '../src/db/schema.js';
import { withDb } from './helpers/db.js';

async function seedAgent(db: Db, name = 'Сафина') {
  const [account] = await db.insert(accounts).values({ name }).returning();
  const [agent] = await db.insert(agents).values({ accountId: account!.id, name }).returning();
  return agent!.id;
}

let db: Awaited<ReturnType<typeof withDb>>;
let agentId: string;

beforeEach(async () => {
  db = await withDb();
  agentId = await seedAgent(db);
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
