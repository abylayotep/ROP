import { describe, expect, it } from 'vitest';
import type { DraftOp, TestCaseSide } from '@/types';
import { sectionLabels } from './RunTable';

const side = (usedChunkIds: string[], usedOpIndexes: number[]): TestCaseSide => ({
  reply: 'ok',
  usedChunkIds,
  usedOpIndexes,
  stageId: null,
  handoff: false,
  handoffReason: null,
  outcome: 'sent',
  cost: '0',
  origin: 'paid',
});

const ops: DraftOp[] = [
  { op: 'note_create', path: 'База знаний/Доставка', body: 'Доставка 1000 тенге' },
  { op: 'note_update', noteId: 'note-1', body: 'Оплата картой' },
];
const base = { noteNames: { 'note-1': 'Оплата' } };
const vault = new Map([['real-1', 'Гарантия']]);

describe('sectionLabels', () => {
  it('names draft notes by their ops and drops the generic fallback', () => {
    expect(sectionLabels(side(['c1', 'c2', 'real-1'], [0, 1]), ops, base, (id) => vault.get(id)))
      .toEqual(['Доставка', 'Оплата', 'Гарантия']);
  });

  it('keeps the fallback when no op is attributed', () => {
    expect(sectionLabels(side(['c1'], []), ops, base, (id) => vault.get(id)))
      .toEqual(['новая заметка черновика']);
  });
});
