import type { KbGenerationPreview, KbGenerationRunDetail } from '@/types';
import { describe, expect, it } from 'vitest';
import {
  generationView,
  initialGenerationState,
  isCurrentGenerationResponse,
  mergeRefreshedGenerationDetail,
  reduceGenerationState,
  type GenerationUiState,
} from './generation-state';
import {
  GenerationRunTarget,
  generationDetailErrorPresentation,
  generationRunErrorPresentation,
  localMidnight,
} from './ChatGenerationPanel';

const selection = { conversationIds: ['conversation-1'], from: '2026-01-01', to: '2026-02-01' };
const preview = { previewId: 'preview-1' } as KbGenerationPreview;
const detail = (status: KbGenerationRunDetail['run']['status'], proposalCount = 1) =>
  ({ run: { status, proposalCount }, proposals: { items: [], nextCursor: null } }) as unknown as KbGenerationRunDetail;

describe('generation UI state', () => {
  it('invalidates a stale preview when selection changes', () => {
    const state = reduceGenerationState(
      { ...initialGenerationState(selection), preview },
      { type: 'selection', selection: { ...selection, conversationIds: ['conversation-2'] } },
    );

    expect(state.preview).toBeNull();
    expect(state.selection.conversationIds).toEqual(['conversation-2']);
  });

  it('describes a completed run with no proposals as empty', () => {
    const state = { ...initialGenerationState(selection), detail: detail('completed', 0) };
    expect(generationView(state)).toBe('empty');
  });

  it('describes cancellation and a failed partial run honestly', () => {
    expect(generationView({ ...initialGenerationState(selection), detail: detail('cancelled') })).toBe('cancelled');
    expect(generationView({ ...initialGenerationState(selection), detail: detail('failed', 2) })).toBe('partial_failure');
  });

  it('preserves explicit proposal selections during polling', () => {
    const selected = reduceGenerationState(
      { ...initialGenerationState(selection), detail: detail('running') },
      { type: 'select_proposal', proposalId: 'proposal-1', selected: true },
    );

    const polled = reduceGenerationState(selected, { type: 'poll', detail: detail('completed') });
    expect(polled.selectedProposalIds).toEqual(['proposal-1']);
  });

  it('treats a cleared date as invalid instead of throwing', () => {
    expect(localMidnight('')).toBeNull();
    expect(localMidnight('2026-09-11')).toBe(new Date('2026-09-11T00:00:00').toISOString());
  });

  it.each([
    ['missing_ai_configuration', null, 'Не сохранён API-ключ OpenRouter.', 'Откройте настройки ИИ, сохраните ключ и повторите разбор.'],
    ['provider_error', 2, 'Часть 3: AI-провайдер не ответил.', 'Проверьте ключ и баланс у провайдера, затем повторите разбор.'],
    ['consolidation_failed', null, 'Не удалось собрать итоговые предложения.', 'Повторите разбор: сохранённые находки будут использованы без повторной обработки чатов.'],
  ])('shows an actionable reason and recovery for %s', (code, ordinal, reason, recovery) => {
    expect(generationRunErrorPresentation({ batchId: ordinal === null ? null : 'batch-id', ordinal, code }))
      .toEqual({ reason, recovery });
  });

  it('rejects a response from an earlier epoch or another run', () => {
    expect(isCurrentGenerationResponse(2, 'run-b', 2, 'run-b')).toBe(true);
    expect(isCurrentGenerationResponse(1, 'run-b', 2, 'run-b')).toBe(false);
    expect(isCurrentGenerationResponse(2, 'run-a', 2, 'run-b')).toBe(false);
  });

  it('clears active run A while run B loads and retries B after its failed load', async () => {
    const runA = { ...detail('running'), run: { ...detail('running').run, id: 'run-a' } } as KbGenerationRunDetail;
    const runB = { ...detail('completed'), run: { ...detail('completed').run, id: 'run-b' } } as KbGenerationRunDetail;
    const target = new GenerationRunTarget('run-a');
    let state: GenerationUiState = { ...initialGenerationState(selection), detail: runA };

    target.switchTo('run-b');
    state = reduceGenerationState(state, { type: 'run_requested' });
    expect(state.detail).toBeNull();
    expect(target.isCurrent('run-a')).toBe(false);
    expect(generationDetailErrorPresentation(state.detail?.run.status)).toEqual({ automatic: false, retryLabel: 'Повторить загрузку' });

    const requested: string[] = [];
    await expect(target.loadCurrent(async (runId) => {
      requested.push(runId);
      throw new Error('load failed');
    })).rejects.toThrow('load failed');
    const loaded = await target.loadCurrent(async (runId) => {
      requested.push(runId);
      return runB;
    });

    expect(requested).toEqual(['run-b', 'run-b']);
    expect(loaded?.run.id).toBe('run-b');
  });

  it('keeps loaded proposal pages when the first page is refreshed', () => {
    const current = {
      ...detail('completed', 2),
      proposals: { items: [{ id: 'first', revision: 1 }, { id: 'second', revision: 1 }], nextCursor: null },
    } as unknown as KbGenerationRunDetail;
    const refreshed = {
      ...detail('completed', 2),
      proposals: { items: [{ id: 'first', revision: 2 }], nextCursor: 'page-2' },
    } as unknown as KbGenerationRunDetail;

    const merged = mergeRefreshedGenerationDetail(current, refreshed);
    expect(merged.proposals.items.map((item) => [item.id, item.revision])).toEqual([
      ['first', 2],
      ['second', 1],
    ]);
    expect(merged.proposals.nextCursor).toBeNull();
  });

  it.each(['applied', 'discarded'] as const)(
    'replaces a stale open draft when another client reports it as %s',
    (status) => {
    const current = {
      ...detail('completed', 1),
      drafts: [{ id: 'draft-1', title: 'Draft', status: 'open', createdAt: '2026-09-12T09:00:00.000Z' }],
      draftsNextCursor: null,
    } as KbGenerationRunDetail;
    const refreshed = {
      ...detail('completed', 1),
      drafts: [{ id: 'draft-1', title: 'Draft', status, createdAt: '2026-09-12T09:00:00.000Z' }],
      draftsNextCursor: null,
    } as KbGenerationRunDetail;

    expect(mergeRefreshedGenerationDetail(current, refreshed).drafts).toEqual([
      expect.objectContaining({ id: 'draft-1', status }),
    ]);
    },
  );

  it('does not let an older polling row overwrite a newer persisted proposal revision', () => {
    const current = {
      ...detail('running', 1),
      proposals: { items: [{ id: 'first', revision: 3, selected: true }], nextCursor: null },
    } as KbGenerationRunDetail;
    const refreshed = {
      ...detail('running', 1),
      proposals: { items: [{ id: 'first', revision: 2, selected: false }], nextCursor: null },
    } as KbGenerationRunDetail;

    expect(mergeRefreshedGenerationDetail(current, refreshed).proposals.items).toEqual([
      expect.objectContaining({ id: 'first', revision: 3, selected: true }),
    ]);
  });

  it('rebases active collection pages so an early null cursor cannot hide later pages', () => {
    const current = {
      ...detail('running', 1),
      drafts: [{ id: 'draft-later' }], draftsNextCursor: null,
      exclusions: [{ batchId: 'excluded-later' }], exclusionsNextCursor: null,
      rawFindings: [{ id: 'raw-later' }], rawFindingsNextCursor: null,
    } as KbGenerationRunDetail;
    const refreshed = {
      ...detail('running', 1),
      drafts: [{ id: 'draft-first' }], draftsNextCursor: '20',
      exclusions: [{ batchId: 'excluded-first' }], exclusionsNextCursor: '20',
    } as KbGenerationRunDetail;

    const merged = mergeRefreshedGenerationDetail(current, refreshed);
    expect(merged.drafts.map((item) => item.id)).toEqual(['draft-first']);
    expect(merged.exclusions.map((item) => item.batchId)).toEqual(['excluded-first']);
    expect(merged.rawFindings).toBeUndefined();
    expect([merged.draftsNextCursor, merged.exclusionsNextCursor, merged.rawFindingsNextCursor]).toEqual(['20', '20', undefined]);
  });

  it('rebases first pages and accepts terminal cursors when an active run finishes', () => {
    const current = {
      ...detail('running', 1),
      proposals: { items: [{ id: 'early', revision: 1 }], nextCursor: null },
      drafts: [], draftsNextCursor: null,
      exclusions: [], exclusionsNextCursor: null,
    } as unknown as KbGenerationRunDetail;
    const terminal = {
      ...detail('completed', 24),
      proposals: { items: [{ id: 'final', revision: 1 }], nextCursor: '20' },
      drafts: [{ id: 'draft-final' }], draftsNextCursor: '20',
      exclusions: [{ batchId: 'excluded-final' }], exclusionsNextCursor: '20',
    } as unknown as KbGenerationRunDetail;

    const merged = mergeRefreshedGenerationDetail(current, terminal);
    expect(merged.proposals.items.map((item) => item.id)).toEqual(['final']);
    expect(merged.proposals.nextCursor).toBe('20');
    expect(merged.draftsNextCursor).toBe('20');
    expect(merged.exclusionsNextCursor).toBe('20');
  });

  it('updates an edited proposal from a loaded later page without losing selections', () => {
    const current = {
      ...initialGenerationState(selection),
      detail: {
        ...detail('completed', 2),
        proposals: { items: [{ id: 'first', revision: 1 }, { id: 'second', revision: 1 }], nextCursor: null },
      } as KbGenerationRunDetail,
      selectedProposalIds: ['first', 'second'],
    };

    const updated = reduceGenerationState(current, {
      type: 'proposal_updated',
      proposal: { id: 'second', revision: 2, status: 'rejected' } as never,
    });

    expect(updated.detail!.proposals.items.map((item) => [item.id, item.revision, item.status])).toEqual([
      ['first', 1, undefined],
      ['second', 2, 'rejected'],
    ]);
    expect(updated.selectedProposalIds).toEqual(['first', 'second']);
  });

  it('ignores an older proposal response after a newer mutation has committed', () => {
    const current = {
      ...initialGenerationState(selection),
      detail: {
        ...detail('completed', 1),
        proposals: { items: [{ id: 'first', revision: 5, selected: true, body: 'new' }], nextCursor: null },
      } as KbGenerationRunDetail,
    };

    const stale = reduceGenerationState(current, {
      type: 'proposal_updated',
      proposal: { id: 'first', revision: 4, selected: false, body: 'old' } as never,
    });

    expect(stale.detail!.proposals.items).toEqual([
      expect.objectContaining({ id: 'first', revision: 5, selected: true, body: 'new' }),
    ]);
  });

  it('does not let a late page overwrite a proposal patched while that page loaded', () => {
    const initial = {
      ...initialGenerationState(selection),
      detail: {
        ...detail('completed', 2),
        proposals: { items: [{ id: 'first', revision: 1 }, { id: 'second', revision: 2, status: 'pending' }], nextCursor: 'page-2' },
      } as KbGenerationRunDetail,
    };
    const patched = reduceGenerationState(initial, {
      type: 'proposal_updated',
      proposal: { id: 'second', revision: 3, status: 'rejected' } as never,
    });
    const appended = reduceGenerationState(patched, {
      type: 'append_page',
      detail: {
        ...detail('completed', 2),
        proposals: { items: [{ id: 'second', revision: 2, status: 'pending' }], nextCursor: null },
      } as KbGenerationRunDetail,
    } as never);

    expect(appended.detail!.proposals.items).toEqual([
      expect.objectContaining({ id: 'first', revision: 1 }),
      expect.objectContaining({ id: 'second', revision: 3, status: 'rejected' }),
    ]);
  });
});
