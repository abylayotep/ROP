import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { KbGenerationRunSummary } from '@/types';
import { GenerationRunRail, mergeDelayedRunFirstPage, mergeRunPages } from './GenerationRunRail';
import { KnowledgeWorkspace, knowledgeTabFromSearch } from './KnowledgeWorkspace';

describe('KnowledgeWorkspace', () => {
  it('keeps four page-level tabs instead of stacking every knowledge tool', () => {
    const html = renderToStaticMarkup(createElement(KnowledgeWorkspace, {
      activeTab: 'drafts',
      onTabChange: () => undefined,
      children: createElement('p', null, 'Review content'),
    }));

    expect(html).toContain('role="tablist"');
    expect(html).toContain('Знания');
    expect(html).toContain('Черновики');
    expect(html).toContain('Запуски');
    expect(html).toContain('Источники и загрузка');
    expect(html).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>Черновики/);
    expect(html).toContain('<main');
  });

  it('opens generation-only deep links in the draft review workspace', () => {
    expect(knowledgeTabFromSearch(new URLSearchParams('generation=run-7'))).toBe('drafts');
    expect(knowledgeTabFromSearch(new URLSearchParams('tab=runs&generation=run-7'))).toBe('runs');
    expect(knowledgeTabFromSearch(new URLSearchParams('note=note-3'))).toBe('knowledge');
  });

  it('marks the active run and keeps the pagination action visible', () => {
    const run = {
      id: 'run-7',
      status: 'completed',
      selection: { conversationIds: ['conversation-1'], from: '2026-08-28T00:00:00Z', to: '2026-09-12T00:00:00Z' },
      modelId: 'model-1',
      temperature: '0.2',
      counts: {
        selectedConversations: 1, selectedMessages: 20, eligibleMessages: 18, eligibleCharacters: 2400,
        skippedAiOrSystem: 1, skippedUnsupported: 1, skippedEmpty: 0, skippedSensitive: 0,
        skippedOversize: 0, skippedNoSeller: 0,
      },
      batchCount: 4,
      completedBatchCount: 4,
      failedBatchCount: 0,
      proposalCount: 8,
      usage: { promptTokens: 1100, completionTokens: 300, cost: '0.12' },
      cancelRequestedAt: null,
      errorCode: null,
      createdAt: '2026-09-11T10:00:00Z',
      updatedAt: '2026-09-11T10:01:00Z',
      classificationCounts: { customer: 3, irrelevant: 1, uncertain: 0 },
      excludedBatchCount: 1,
      errors: [],
      drafts: [],
      draftsNextCursor: null,
    } satisfies KbGenerationRunSummary;
    const html = renderToStaticMarkup(createElement(GenerationRunRail, {
      runs: [run], activeRunId: run.id, loading: false, hasMore: true, loadingMore: false,
      onSelect: () => undefined, onRetry: () => undefined, onLoadMore: () => undefined,
    }));

    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('Показать ещё запусков');
    expect(html).toContain('8');
  });

  it('refreshes the active run summary without losing the rest of the rail', () => {
    const previous = { id: 'run-1', proposalCount: 1 } as KbGenerationRunSummary;
    const other = { id: 'run-2', proposalCount: 2 } as KbGenerationRunSummary;
    const refreshed = { ...previous, proposalCount: 9 };
    expect(mergeRunPages([previous, other], [refreshed]).map((run) => [run.id, run.proposalCount])).toEqual([
      ['run-1', 9], ['run-2', 2],
    ]);
  });

  it('merges a delayed first run page without replacing its newer deep-linked detail', () => {
    const deepLinked = { id: 'run-2', createdAt: '2026-09-11T10:00:00Z', proposalCount: 9, updatedAt: '2026-09-11T10:05:00Z' } as KbGenerationRunSummary;
    const delayedFirstPage = [
      { id: 'run-3', createdAt: '2026-09-12T10:00:00Z', proposalCount: 2, updatedAt: '2026-09-12T10:01:00Z' },
      { id: 'run-2', createdAt: '2026-09-11T10:00:00Z', proposalCount: 1, updatedAt: '2026-09-11T10:01:00Z' },
      { id: 'run-1', createdAt: '2026-09-10T10:00:00Z', proposalCount: 4, updatedAt: '2026-09-10T10:01:00Z' },
    ] as KbGenerationRunSummary[];

    expect(mergeDelayedRunFirstPage([deepLinked], delayedFirstPage).map((run) => [run.id, run.proposalCount])).toEqual([
      ['run-3', 2], ['run-2', 9], ['run-1', 4],
    ]);
  });
});
