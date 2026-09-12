import { useLayoutEffect } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as api from '@/api';
import type { KbGenerationRunDetail } from '@/types';
import { ChatGenerationPanel } from './ChatGenerationPanel';

vi.mock('@/api', () => ({
  getKnowledgeGenerationRun: vi.fn(),
  humanError: (error: Error) => error.message,
}));
vi.mock('@/hooks/useApi', () => ({
  useApi: () => ({ data: undefined, loading: false, error: undefined, reload: vi.fn() }),
}));
vi.mock('./CommunicationStyleCard', () => ({ CommunicationStyleCard: () => null }));
vi.mock('./RecentHistoryPreparation', () => ({ RecentHistoryPreparation: () => null }));
vi.mock('./ProposalWorkspace', () => ({
  ProposalWorkspace: ({ detail }: { detail: KbGenerationRunDetail }) => <div data-reviewed-run={detail.run.id} />,
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
  vi.clearAllMocks();
});

describe('ChatGenerationPanel run switching', () => {
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
