import { describe, expect, it } from 'vitest';
import { draftOrigin, nextStep, pluralRu, runErrorSummary, tabAfterKey, wizardStep } from './training-state';

const run = (status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled', proposalCount = 3, drafts = 0) =>
  ({ run: { status, proposalCount }, drafts: Array.from({ length: drafts }, (_, i) => ({ id: `d${i}` })) });

describe('wizardStep', () => {
  it('starts at the period step without a run', () => expect(wizardStep(null, false)).toBe('period'));
  it('stays on processing while active or failed empty', () => {
    expect(wizardStep(run('running'), false)).toBe('processing');
    expect(wizardStep(run('queued'), false)).toBe('processing');
    expect(wizardStep(run('failed', 0), false)).toBe('processing');
    expect(wizardStep(run('cancelled', 0), false)).toBe('processing');
  });
  it('moves to selection, then draft, and back on request', () => {
    expect(wizardStep(run('completed'), false)).toBe('selection');
    expect(wizardStep(run('completed', 0), false)).toBe('selection');
    expect(wizardStep(run('failed', 2), false)).toBe('selection');
    expect(wizardStep(run('completed', 3, 1), false)).toBe('draft');
    expect(wizardStep(run('completed', 3, 1), true)).toBe('selection');
  });
});

describe('nextStep', () => {
  const base = { owner: true, activeRun: null, openDrafts: 0, noteCount: 4 };
  it('says nothing to non-owners or when all is done', () => {
    expect(nextStep({ ...base, owner: false, openDrafts: 3 })).toBeNull();
    expect(nextStep(base)).toBeNull();
  });
  it('ranks an active run over drafts over an empty base', () => {
    const activeRun = { id: 'r1', completedBatchCount: 1, batchCount: 3 };
    expect(nextStep({ ...base, activeRun, openDrafts: 2, noteCount: 0 })).toEqual({ kind: 'running', percent: 33, runId: 'r1' });
    expect(nextStep({ ...base, openDrafts: 2, noteCount: 0 })).toEqual({ kind: 'review', count: 2 });
    expect(nextStep({ ...base, noteCount: 0 })).toEqual({ kind: 'empty' });
    expect(nextStep({ ...base, activeRun: { id: 'r2', completedBatchCount: 0, batchCount: 0 } })).toEqual({ kind: 'running', percent: 0, runId: 'r2' });
  });
});

describe('draftOrigin', () => {
  it('labels drafts by where they came from', () => {
    expect(draftOrigin({ origin: 'coach', title: 'Правило' })).toBe('Тренер');
    expect(draftOrigin({ origin: 'manual', title: 'Скрипт продаж из WhatsApp' })).toBe('Из переписки');
    expect(draftOrigin({ origin: 'manual', title: 'База знаний из WhatsApp · 4' })).toBe('Из переписки');
    expect(draftOrigin({ origin: 'manual', title: 'Правка цен' })).toBe('Вручную');
  });
});

describe('tabAfterKey', () => {
  it('moves tab selection with arrows, Home, and End', () => {
    const ids = ['knowledge', 'drafts', 'runs', 'sources'] as const;
    expect(tabAfterKey(ids, 'drafts', 'ArrowRight')).toBe('runs');
    expect(tabAfterKey(ids, 'knowledge', 'ArrowLeft')).toBe('sources');
    expect(tabAfterKey(ids, 'runs', 'Home')).toBe('knowledge');
    expect(tabAfterKey(ids, 'drafts', 'End')).toBe('sources');
    expect(tabAfterKey(ids, 'drafts', 'Enter')).toBeNull();
  });
});

describe('pluralRu', () => {
  it('picks the Russian plural form', () => {
    const drafts = (n: number) => `${n} ${pluralRu(n, 'черновик', 'черновика', 'черновиков')}`;
    expect(drafts(1)).toBe('1 черновик');
    expect(drafts(3)).toBe('3 черновика');
    expect(drafts(5)).toBe('5 черновиков');
    expect(drafts(11)).toBe('11 черновиков');
    expect(drafts(12)).toBe('12 черновиков');
    expect(drafts(21)).toBe('21 черновик');
    expect(drafts(22)).toBe('22 черновика');
  });
});

describe('runErrorSummary', () => {
  const batch = (ordinal: number, code = 'unsafe_output') => ({ batchId: `b${ordinal}`, ordinal, code });

  it('reports nothing for a clean run', () => {
    expect(runErrorSummary({ status: 'completed', batchCount: 83, errors: [] })).toBeNull();
  });

  it('folds batch errors of a finished run into one calm line', () => {
    const summary = runErrorSummary({ status: 'completed', batchCount: 83, errors: [batch(8), batch(11), batch(11, 'batch_failed')] });
    expect(summary).toEqual({ severity: 'partial', text: 'Не обработано частей: 2 из 83. Остальное разобрано — факты ниже можно отбирать.', runLevel: [] });
  });

  it('keeps run-level errors separate and marks a failed run as an error', () => {
    const summary = runErrorSummary({ status: 'failed', batchCount: 4, errors: [{ batchId: null, ordinal: null, code: 'missing_ai_configuration' }, batch(1)] });
    expect(summary?.severity).toBe('error');
    expect(summary?.runLevel).toHaveLength(1);
    expect(summary?.text).toBe('Не обработано частей: 1 из 4.');
  });

  it('has no batch line when only the run itself failed', () => {
    const summary = runErrorSummary({ status: 'failed', batchCount: 4, errors: [{ batchId: null, ordinal: null, code: 'consolidation_failed' }] });
    expect(summary).toEqual({ severity: 'error', text: null, runLevel: [{ batchId: null, ordinal: null, code: 'consolidation_failed' }] });
  });
});
