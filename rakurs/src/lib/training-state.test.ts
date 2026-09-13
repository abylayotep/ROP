import { describe, expect, it } from 'vitest';
import { draftOrigin, nextStep, tabAfterKey, wizardStep } from './training-state';

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
