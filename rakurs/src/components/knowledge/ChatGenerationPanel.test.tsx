import { useLayoutEffect, type ComponentProps } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as api from '@/api';
import type { KbGenerationRunDetail } from '@/types';
import { ChatGenerationPanel } from './ChatGenerationPanel';

vi.mock('@/api', () => ({
  getKnowledgeGenerationRun: vi.fn(),
  retryKnowledgeGenerationRun: vi.fn(),
  humanError: (error: Error) => error.message,
}));
vi.mock('@/hooks/useApi', () => ({
  useApi: () => ({ data: undefined, loading: false, error: undefined, reload: vi.fn() }),
}));
vi.mock('./CommunicationStyleCard', () => ({ CommunicationStyleCard: () => null }));
vi.mock('./RecentHistoryPreparation', () => ({ RecentHistoryPreparation: () => null }));
vi.mock('./ProposalWorkspace', () => ({
  ProposalWorkspace: ({ detail, onLoadMoreProposals, collectionState }: ComponentProps<typeof import('./ProposalWorkspace').ProposalWorkspace>) => (
    <div data-reviewed-run={detail.run.id}>
      <button onClick={onLoadMoreProposals} disabled={collectionState?.proposals?.loading}>Load proposals</button>
      {collectionState?.proposals?.loading && <span role="status">Loading proposals</span>}
      {collectionState?.proposals?.error && <span role="alert">{collectionState.proposals.error}</span>}
    </div>
  ),
}));

function runDetail(id: string, status: KbGenerationRunDetail['run']['status']): KbGenerationRunDetail {
  return {
    run: {
      id, status,
      selection: { conversationIds: [], from: '2026-09-01', to: '2026-09-12' },
      modelId: 'model-1', temperature: '0.2',
      counts: {
        selectedConversations: 1, selectedMessages: 20, eligibleMessages: 18, eligibleCharacters: 2400,
        skippedAiOrSystem: 1, skippedUnsupported: 1, skippedEmpty: 0, skippedSensitive: 0,
        skippedOversize: 0, skippedNoSeller: 0,
      },
      batchCount: 4, completedBatchCount: 2, failedBatchCount: 0, proposalCount: 0,
      usage: { promptTokens: 1100, completionTokens: 300, cost: '0.12' },
      cancelRequestedAt: null, errorCode: null,
      createdAt: '2026-09-11T10:00:00Z', updatedAt: '2026-09-11T10:01:00Z',
      classificationCounts: { customer: 3, irrelevant: 1, uncertain: 0 },
      excludedBatchCount: 1, errors: [], drafts: [], draftsNextCursor: null,
    },
    proposals: { items: [], nextCursor: null },
    drafts: [{ id: `draft-${id}`, title: `Draft from ${id}`, status: 'open', createdAt: '2026-09-11T10:01:00Z' }],
    draftsNextCursor: null, exclusions: [], exclusionsNextCursor: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe('ChatGenerationPanel run switching', () => {
  it('isolates action errors, collection errors, and pending collection work across run switches', async () => {
    const runA = runDetail('run-a', 'failed');
    runA.draftsNextCursor = 'draft-page-2';
    runA.proposals.nextCursor = 'proposal-page-2';
    const runB = runDetail('run-b', 'completed');
    runB.proposals.nextCursor = 'proposal-page-2';
    const pendingA = deferred<KbGenerationRunDetail>();
    const firstB = deferred<KbGenerationRunDetail>();
    const retryB = deferred<KbGenerationRunDetail>();
    const pendingB = deferred<KbGenerationRunDetail>();
    const getRun = vi.mocked(api.getKnowledgeGenerationRun)
      .mockResolvedValueOnce(runA)
      .mockRejectedValueOnce(new Error('A drafts failed'))
      .mockReturnValueOnce(pendingA.promise)
      .mockReturnValueOnce(firstB.promise)
      .mockReturnValueOnce(retryB.promise)
      .mockReturnValueOnce(pendingB.promise)
      .mockResolvedValueOnce(runB);
    vi.mocked(api.retryKnowledgeGenerationRun).mockRejectedValueOnce(new Error('A action failed'));
    let renderer: ReactTestRenderer | undefined;
    let firstBCommit = '';
    function CommitProbe({ runId }: { runId: string }) {
      useLayoutEffect(() => {
        if (runId === 'run-b') firstBCommit = JSON.stringify(renderer?.toJSON());
      }, [runId]);
      return null;
    }
    const panel = (runId: string) => (
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <ChatGenerationPanel agentId="agent-1" initialRunId={runId} onRunId={() => undefined} />
        <CommitProbe runId={runId} />
      </MemoryRouter>
    );
    const button = (label: string) => renderer!.root.findAllByType('button').find((node) => node.children.includes(label))!;
    const output = () => JSON.stringify(renderer!.toJSON());
    const assertNoStaleState = (value: string) => {
      expect(value).not.toContain('A action failed');
      expect(value).not.toContain('A drafts failed');
      expect(value).not.toContain('A proposals failed');
      expect(value).not.toContain('Draft from run-a');
      expect(value).not.toContain('Loading proposals');
      expect(value).not.toContain('Загружаем черновики…');
    };

    try {
      await act(async () => { renderer = create(panel('run-a')); });
      await act(async () => { button('Повторить незавершённые пакеты').props.onClick(); });
      await act(async () => { button('Показать ещё черновики').props.onClick(); });
      await act(async () => { button('Load proposals').props.onClick(); });
      expect(output()).toContain('A action failed');
      expect(output()).toContain('A drafts failed');
      expect(output()).toContain('Loading proposals');

      await act(async () => { renderer!.update(panel('run-b')); });
      assertNoStaleState(firstBCommit);
      await act(async () => { firstB.reject(new Error('B load failed')); });
      assertNoStaleState(output());
      expect(output()).toContain('B load failed');
      await act(async () => { button('Повторить загрузку').props.onClick(); });
      await act(async () => { retryB.resolve(runB); });
      assertNoStaleState(output());
      expect(output()).toContain('Draft from run-b');
      expect(renderer!.root.findByProps({ 'data-reviewed-run': 'run-b' })).toBeDefined();
      expect(renderer!.root.findAllByProps({ role: 'alert' })).toHaveLength(0);
      expect(renderer!.root.findAllByProps({ role: 'status' })).toHaveLength(0);

      // B can load the same collection while A's request remains unresolved.
      await act(async () => { button('Load proposals').props.onClick(); });
      expect(getRun.mock.calls.map(([, runId]) => runId)).toEqual(['run-a', 'run-a', 'run-a', 'run-b', 'run-b', 'run-b']);
      expect(output()).toContain('Loading proposals');
      await act(async () => { pendingA.reject(new Error('A proposals failed')); });
      expect(output()).not.toContain('A proposals failed');
      expect(output()).toContain('Loading proposals');
      await act(async () => { pendingB.reject(new Error('B proposals failed')); });
      expect(output()).toContain('B proposals failed');
      expect(output()).not.toContain('Loading proposals');
      await act(async () => { button('Load proposals').props.onClick(); });
      expect(renderer!.root.findAllByProps({ role: 'alert' })).toHaveLength(0);
      expect(renderer!.root.findAllByProps({ role: 'status' })).toHaveLength(0);
      assertNoStaleState(output());
    } finally {
      await act(async () => { renderer?.unmount(); });
    }
  });

  it('hides A before passive effects, suppresses its poll, and installs B after an explicit retry', async () => {
    vi.useFakeTimers();
    const pollA = deferred<KbGenerationRunDetail>();
    const firstB = deferred<KbGenerationRunDetail>();
    const retryB = deferred<KbGenerationRunDetail>();
    const getRun = vi.mocked(api.getKnowledgeGenerationRun)
      .mockResolvedValueOnce(runDetail('run-a', 'running'))
      .mockReturnValueOnce(pollA.promise)
      .mockReturnValueOnce(firstB.promise)
      .mockReturnValueOnce(retryB.promise);
    let renderer: ReactTestRenderer | undefined;
    const commits: Array<{ runId: string; output: string }> = [];

    function CommitProbe({ runId }: { runId: string }) {
      useLayoutEffect(() => {
        // Capture the committed tree before the panel's passive run_requested effect.
        commits.push({ runId, output: JSON.stringify(renderer?.toJSON()) });
      }, [runId]);
      return null;
    }
    const panel = (runId: string) => (
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <ChatGenerationPanel agentId="agent-1" initialRunId={runId} onRunId={() => undefined} readOnly />
        <CommitProbe runId={runId} />
      </MemoryRouter>
    );

    try {
      await act(async () => { renderer = create(panel('run-a')); });
      expect(JSON.stringify(renderer!.toJSON())).toContain('Draft from run-a');
      await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
      expect(getRun.mock.calls.map(([, runId]) => runId)).toEqual(['run-a', 'run-a']);

      await act(async () => { renderer!.update(panel('run-b')); });
      const firstBCommit = commits.find((commit) => commit.runId === 'run-b')!.output;
      expect(firstBCommit).not.toContain('Draft from run-a');
      expect(firstBCommit).not.toContain('Статус запуска');
      expect(firstBCommit).not.toContain('Обработка продолжается.');

      await act(async () => {
        pollA.reject(new Error('stale A poll failed'));
        firstB.reject(new Error('B load failed'));
      });
      let output = JSON.stringify(renderer!.toJSON());
      expect(output).toContain('B load failed');
      expect(output).not.toContain('stale A poll failed');
      expect(output).not.toContain('Повторяем автоматически');
      expect(output).not.toContain('Draft from run-a');
      const retry = renderer!.root.findAllByType('button').find((button) => button.children.includes('Повторить загрузку'))!;
      expect(retry).toBeDefined();
      expect(retry.props.disabled).toBe(false);
      await act(async () => { await vi.advanceTimersByTimeAsync(4500); });
      expect(getRun.mock.calls.map(([, runId]) => runId)).toEqual(['run-a', 'run-a', 'run-b']);

      await act(async () => { retry.props.onClick(); });
      expect(getRun.mock.calls.map(([, runId]) => runId)).toEqual(['run-a', 'run-a', 'run-b', 'run-b']);
      await act(async () => { retryB.resolve(runDetail('run-b', 'completed')); });
      output = JSON.stringify(renderer!.toJSON());
      expect(renderer!.root.findByProps({ 'data-reviewed-run': 'run-b' })).toBeDefined();
      expect(output).toContain('Draft from run-b');
      expect(output).not.toContain('Draft from run-a');
      expect(output).not.toContain('B load failed');
      expect(renderer!.root.findAllByProps({ role: 'alert' })).toHaveLength(0);
      expect(renderer!.root.findAllByType('button').some((button) => button.children.includes('Повторить загрузку'))).toBe(false);
    } finally {
      await act(async () => { renderer?.unmount(); });
    }
  });
});
