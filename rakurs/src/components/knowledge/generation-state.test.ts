import type { KbGenerationPreview, KbGenerationRunDetail } from '@/types';
import { describe, expect, it } from 'vitest';
import {
  generationView,
  initialGenerationState,
  isCurrentGenerationResponse,
  mergeRefreshedGenerationDetail,
  reduceGenerationState,
} from './generation-state';
import { localMidnight } from './ChatGenerationPanel';

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

  it('rejects a response from an earlier epoch or another run', () => {
    expect(isCurrentGenerationResponse(2, 'run-b', 2, 'run-b')).toBe(true);
    expect(isCurrentGenerationResponse(1, 'run-b', 2, 'run-b')).toBe(false);
    expect(isCurrentGenerationResponse(2, 'run-a', 2, 'run-b')).toBe(false);
  });

  it('keeps loaded proposal pages when the first page is refreshed', () => {
    const current = {
      ...detail('completed', 2),
      proposals: { items: [{ id: 'first', revision: 1 }, { id: 'second', revision: 1 }], nextCursor: null },
    } as KbGenerationRunDetail;
    const refreshed = {
      ...detail('completed', 2),
      proposals: { items: [{ id: 'first', revision: 2 }], nextCursor: 'page-2' },
    } as KbGenerationRunDetail;

    const merged = mergeRefreshedGenerationDetail(current, refreshed);
    expect(merged.proposals.items.map((item) => [item.id, item.revision])).toEqual([
      ['first', 2],
      ['second', 1],
    ]);
    expect(merged.proposals.nextCursor).toBeNull();
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
