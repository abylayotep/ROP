import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { KbGenerationRunSummary } from '@/types';

vi.mock('@/hooks/usePollingApi', () => ({ usePollingApi: () => ({
  data: undefined, error: undefined, loading: false, refreshing: false, reload: () => undefined,
}) }));

import { GenerationRunRail } from '@/components/knowledge/GenerationRunRail';
import { RecentHistoryPreparation } from '@/components/knowledge/RecentHistoryPreparation';
import { WizardSteps } from './WizardSteps';

const run = {
  id: 'run-1',
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
  proposalCount: 15,
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

describe('WizardSteps', () => {
  it('marks earlier steps done and the current one as the step', () => {
    const html = renderToStaticMarkup(createElement(WizardSteps, { current: 'selection' }));
    const items = html.match(/<li[^>]*>.*?<\/li>/g) ?? [];
    expect(items).toHaveLength(4);
    expect(items.map((item) => item.replace(/<[^>]+>/g, ''))).toEqual([
      expect.stringContaining('Период'), expect.stringContaining('Разбор'),
      expect.stringContaining('Отбор'), expect.stringContaining('Черновик'),
    ]);
    expect(items[0]).toContain('is-done');
    expect(items[1]).toContain('is-done');
    expect(items[2]).toContain('aria-current="step"');
    expect(items[2]).not.toContain('is-done');
    expect(items[3]).not.toContain('is-done');
    expect(items[3]).not.toContain('aria-current');
  });
});

describe('GenerationRunRail copy', () => {
  it('speaks the owner\'s vocabulary', () => {
    const html = renderToStaticMarkup(createElement(GenerationRunRail, {
      runs: [run], activeRunId: null, loading: false, hasMore: false, loadingMore: false,
      onSelect: () => undefined, onRetry: () => undefined, onLoadMore: () => undefined,
    }));
    expect(html).toContain('История разборов');
    expect(html).toContain('найдено фактов: 15');
    expect(html).not.toContain('пакетов');
    expect(html).not.toContain('клиентских');
  });

  it('says when there is no history yet', () => {
    const html = renderToStaticMarkup(createElement(GenerationRunRail, {
      runs: [], activeRunId: null, loading: false, hasMore: false, loadingMore: false,
      onSelect: () => undefined, onRetry: () => undefined, onLoadMore: () => undefined,
    }));
    expect(html).toContain('Разборов пока нет.');
  });
});

describe('RecentHistoryPreparation copy', () => {
  it('starts a «разбор»', () => {
    const html = renderToStaticMarkup(createElement(RecentHistoryPreparation, { agentId: 'agent', busy: false, onStart: () => undefined }));
    expect(html).toContain('Начать разбор');
    expect(renderToStaticMarkup(createElement(RecentHistoryPreparation, { agentId: 'agent', busy: true, onStart: () => undefined })))
      .toContain('Запускаем разбор…');
  });
});
