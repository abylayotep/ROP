import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client.js';
import { agentRules, agents, kbNotes } from '../src/db/schema.js';
import { checkProposal } from '../src/lib/ai/fact-check.js';
import { saveNote } from '../src/lib/knowledge/notes.js';
import { createAccountWithOwner } from '../src/lib/provision.js';
import { withDb } from './helpers/db.js';

let db: Db;
let agentId: string;

beforeEach(async () => {
  db = await withDb();
  const { accountId } = await createAccountWithOwner(db, {
    company: 'Сафина',
    email: 'owner@example.com',
    name: 'Владелец',
    initials: 'ВЛ',
    password: 'correct-horse-battery',
  });
  agentId = randomUUID();
  await db.insert(agents).values({ id: agentId, accountId, name: 'Сафина' });
});

describe('checkProposal', () => {
  it('turns a rule carrying an unknown number into a note proposal', async () => {
    const checked = await checkProposal(db, agentId, {
      kind: 'rule',
      category: 'business',
      text: 'Доставка по Алматы 1500 ₸.',
    });
    expect(checked.proposal.kind).toBe('note');
    expect(checked.warning).toContain('1500');
  });

  it('leaves a rule alone when the number is already in a note', async () => {
    await saveNote(db, { agentId, path: 'Доставка', body: 'По городу 1500 ₸.' });
    const checked = await checkProposal(db, agentId, {
      kind: 'rule',
      category: 'business',
      text: 'Про доставку говори: 1500 ₸.',
    });
    expect(checked.proposal.kind).toBe('rule');
    expect(checked.warning).toBeNull();
  });

  it('leaves a rule alone when the number is already in another rule', async () => {
    await db.insert(agentRules).values({
      agentId,
      category: 'business',
      text: 'Работаем с 2015 года.',
      origin: 'manual',
      position: 0,
    });
    const checked = await checkProposal(db, agentId, {
      kind: 'rule',
      category: 'business',
      text: 'Скажи, что с 2015 года на рынке.',
    });
    expect(checked.proposal.kind).toBe('rule');
  });

  it('leaves a rule with no numbers alone', async () => {
    const checked = await checkProposal(db, agentId, {
      kind: 'rule',
      category: 'forbid',
      text: 'Не обещай скидку.',
    });
    expect(checked.proposal.kind).toBe('rule');
    expect(checked.warning).toBeNull();
  });

  it('does not check a note proposal', async () => {
    const checked = await checkProposal(db, agentId, {
      kind: 'note',
      path: 'Доставка',
      body: '1500 ₸.',
    });
    expect(checked.proposal.kind).toBe('note');
    expect(checked.warning).toBeNull();
  });

  it('does not check a note_edit proposal', async () => {
    const checked = await checkProposal(db, agentId, {
      kind: 'note_edit',
      noteId: randomUUID(),
      body: '1500 ₸.',
    });
    expect(checked.proposal.kind).toBe('note_edit');
    expect(checked.warning).toBeNull();
  });

  it('ignores a disabled rule as a source: its number still moves to a note', async () => {
    await db.insert(agentRules).values({
      agentId,
      category: 'business',
      text: 'Работаем с 2015 года.',
      origin: 'manual',
      position: 0,
      enabled: false,
    });
    const checked = await checkProposal(db, agentId, {
      kind: 'rule',
      category: 'business',
      text: 'Скажи, что с 2015 года на рынке.',
    });
    expect(checked.proposal.kind).toBe('note');
    expect(checked.warning).toContain('2015');
  });

  it('picks a free path when the obvious one is already a note', async () => {
    await saveNote(db, {
      agentId,
      path: 'Прочее/Доставка по Алматы 1500 ₸.',
      body: 'Существующая заметка, не связанная с этим предложением.',
    });
    const checked = await checkProposal(db, agentId, {
      kind: 'rule',
      category: 'business',
      text: 'Доставка по Алматы 1500 ₸.',
    });
    expect(checked.proposal.kind).toBe('note');
    const path = (checked.proposal as { path: string }).path;
    expect(path).not.toBe('Прочее/Доставка по Алматы 1500 ₸.');

    const collisions = await db.select().from(kbNotes).where(eq(kbNotes.agentId, agentId));
    // The rewritten path must not already belong to some other, unrelated note.
    const existing = collisions.find((row) => row.path === path);
    expect(existing).toBeUndefined();
  });

  it('checks a rule_edit proposal`s text the same way', async () => {
    const checked = await checkProposal(db, agentId, {
      kind: 'rule_edit',
      ruleId: randomUUID(),
      text: 'Доставка по Алматы 1500 ₸.',
    });
    expect(checked.proposal.kind).toBe('note');
    expect(checked.warning).toContain('1500');
  });

  it('leaves a rule_edit proposal with no text alone', async () => {
    const ruleId = randomUUID();
    const checked = await checkProposal(db, agentId, {
      kind: 'rule_edit',
      ruleId,
      enabled: false,
    });
    expect(checked.proposal).toEqual({ kind: 'rule_edit', ruleId, enabled: false });
    expect(checked.warning).toBeNull();
  });
});
