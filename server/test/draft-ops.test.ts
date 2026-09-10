import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client.js';
import { accounts, agentRules, agents, kbChunks, kbNotes } from '../src/db/schema.js';
import { deleteNote, saveNote } from '../src/lib/knowledge/notes.js';
import { applyOps, baseOf, staleOps } from '../src/lib/drafts/ops.js';
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

describe('applyOps', () => {
  it('creates a note with its sections', async () => {
    await applyOps(db, agentId, [{ op: 'note_create', path: 'Доставка', body: '## По городу\n1500 ₸.' }]);
    const [chunk] = await db.select().from(kbChunks).where(eq(kbChunks.agentId, agentId));
    expect(chunk!.title).toBe('Доставка › По городу');
  });

  it('creates a rule at the end of its category', async () => {
    await applyOps(db, agentId, [{ op: 'rule_create', category: 'forbid', text: 'Не обещай скидку.' }]);
    const [rule] = await db.select().from(agentRules).where(eq(agentRules.agentId, agentId));
    expect(rule!.origin).toBe('coach');
  });

  it('places a new rule after one that is already in its category', async () => {
    await db.insert(agentRules).values({ agentId, category: 'forbid', text: 'Первое.', position: 0 });
    await applyOps(db, agentId, [{ op: 'rule_create', category: 'forbid', text: 'Второе.' }]);
    const rows = await db.select().from(agentRules).where(eq(agentRules.agentId, agentId));
    expect(rows.map((r) => [r.text, r.position])).toEqual([
      ['Первое.', 0],
      ['Второе.', 1],
    ]);
  });

  it('keeps a note at its path when only the body changes', async () => {
    const note = await saveNote(db, { agentId, path: 'Доставка', body: '1500 ₸.' });
    await applyOps(db, agentId, [{ op: 'note_update', noteId: note.id, body: '1600 ₸.' }]);
    const [row] = await db.select().from(kbNotes).where(eq(kbNotes.id, note.id));
    expect(row).toMatchObject({ path: 'Доставка', body: '1600 ₸.' });
  });

  it('updates a rule\'s text', async () => {
    const [rule] = await db.insert(agentRules).values({ agentId, category: 'tone', text: 'Старый текст.' }).returning();
    await applyOps(db, agentId, [{ op: 'rule_update', ruleId: rule!.id, text: 'Новый текст.' }]);
    const [row] = await db.select().from(agentRules).where(eq(agentRules.id, rule!.id));
    expect(row!.text).toBe('Новый текст.');
  });

  it('does not bump the agent\'s config version', async () => {
    await applyOps(db, agentId, [{ op: 'note_create', path: 'Доставка', body: '1500 ₸.' }]);
    const [note] = await db.select().from(kbNotes).where(eq(kbNotes.agentId, agentId));
    expect(note).toMatchObject({ path: 'Доставка', body: '1500 ₸.' });
    const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(row!.configVersion).toBe(1);
  });
});

describe('baseOf', () => {
  it('takes the updatedAt of everything the ops touch', async () => {
    const note = await saveNote(db, { agentId, path: 'Доставка', body: '1500 ₸.' });
    const base = await baseOf(db, agentId, [{ op: 'note_update', noteId: note.id, body: '1600 ₸.' }]);
    expect(base.notes![note.id]).toBe(note.updatedAt.toISOString());
  });
});

describe('staleOps', () => {
  it('names a note that moved since the base was taken', async () => {
    const note = await saveNote(db, { agentId, path: 'Доставка', body: '1500 ₸.' });
    const ops = [{ op: 'note_update' as const, noteId: note.id, body: '1600 ₸.' }];
    const base = await baseOf(db, agentId, ops);
    await saveNote(db, { agentId, noteId: note.id, path: 'Доставка', body: '1700 ₸.' });
    expect(await staleOps(db, agentId, ops, base)).toEqual(['Доставка']);
  });

  it('names a note that was deleted since the base was taken', async () => {
    const note = await saveNote(db, { agentId, path: 'Доставка', body: '1500 ₸.' });
    const ops = [{ op: 'note_update' as const, noteId: note.id, body: '1600 ₸.' }];
    const base = await baseOf(db, agentId, ops);
    await deleteNote(db, agentId, note.id);
    expect(await staleOps(db, agentId, ops, base)).toEqual(['Доставка']);
  });

  it('says nothing is stale when nothing moved', async () => {
    const [rule] = await db.insert(agentRules).values({ agentId, category: 'tone', text: 'На «вы».' }).returning();
    const note = await saveNote(db, { agentId, path: 'Доставка', body: '1500 ₸.' });
    const ops = [
      { op: 'rule_update' as const, ruleId: rule!.id, enabled: true },
      { op: 'note_update' as const, noteId: note.id, body: '1500 ₸.' },
    ];
    expect(await staleOps(db, agentId, ops, await baseOf(db, agentId, ops))).toEqual([]);
  });

  it('names a rule whose text changed since the base was taken', async () => {
    const [rule] = await db.insert(agentRules).values({ agentId, category: 'tone', text: 'На «вы».' }).returning();
    const ops = [{ op: 'rule_update' as const, ruleId: rule!.id, enabled: false }];
    const base = await baseOf(db, agentId, ops);
    await db.update(agentRules).set({ text: 'На «ты».', updatedAt: new Date() })
      .where(and(eq(agentRules.id, rule!.id), eq(agentRules.agentId, agentId)));
    expect(await staleOps(db, agentId, ops, base)).toEqual(['На «ты».']);
  });

  it('names a rule that was deleted since the base was taken', async () => {
    const [rule] = await db.insert(agentRules).values({ agentId, category: 'tone', text: 'На «вы».' }).returning();
    const ops = [{ op: 'rule_update' as const, ruleId: rule!.id, enabled: false }];
    const base = await baseOf(db, agentId, ops);
    await db.delete(agentRules).where(eq(agentRules.id, rule!.id));
    expect(await staleOps(db, agentId, ops, base)).toEqual(['На «вы».']);
  });
});
