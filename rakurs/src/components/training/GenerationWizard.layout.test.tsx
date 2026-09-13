import { MemoryRouter } from 'react-router-dom';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as api from '@/api';
import type { KbGenerationRunDetail } from '@/types';
import { GenerationWizard } from './GenerationWizard';

vi.mock('@/api', async (original) => ({
  ...(await original() as object),
  getKnowledgeGenerationRun: vi.fn(),
  listKnowledgeGenerationRuns: vi.fn(),
}));
vi.mock('@/hooks/useApi', () => ({
  useApi: () => ({ data: undefined, loading: false, error: undefined, reload: vi.fn() }),
}));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ ok: () => undefined, fail: () => undefined }) }));
vi.mock('@/components/knowledge/RecentHistoryPreparation', () => ({ RecentHistoryPreparation: () => null }));

function completedRun(): KbGenerationRunDetail {
  return {
    run: {
      id: 'run-1', status: 'completed',
      selection: { conversationIds: [], from: '2026-09-01', to: '2026-09-12' },
      modelId: 'model-1', temperature: '0.2',
      counts: {
        selectedConversations: 1, selectedMessages: 20, eligibleMessages: 18, eligibleCharacters: 2400,
        skippedAiOrSystem: 1, skippedUnsupported: 1, skippedEmpty: 0, skippedSensitive: 0,
        skippedOversize: 0, skippedNoSeller: 0,
      },
      batchCount: 4, completedBatchCount: 4, failedBatchCount: 0, proposalCount: 1,
      usage: { promptTokens: 1100, completionTokens: 300, cost: '0.12' },
      cancelRequestedAt: null, errorCode: null,
      createdAt: '2026-09-11T10:00:00Z', updatedAt: '2026-09-11T10:01:00Z',
      classificationCounts: { customer: 3, irrelevant: 1, uncertain: 0 },
      excludedBatchCount: 0, errors: [], drafts: [], draftsNextCursor: null,
    },
    proposals: { items: [], nextCursor: null },
    drafts: [],
    draftsNextCursor: null, exclusions: [], exclusionsNextCursor: null,
  };
}

const wizard = (runId: string | null) => (
  <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
    <GenerationWizard agentId="agent-1" initialRunId={runId} onRunId={() => undefined} onOpenReplies={() => undefined} />
  </MemoryRouter>
);

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => { renderer?.unmount(); });
  renderer = undefined;
  vi.resetAllMocks();
});

describe('GenerationWizard layout', () => {
  it('marks «Период» as the current step only when no run is linked', async () => {
    vi.mocked(api.listKnowledgeGenerationRuns).mockResolvedValue({ items: [], nextCursor: null });
    await act(async () => { renderer = create(wizard(null)); });
    const current = renderer!.root.findAll((node) => node.type === 'li' && node.props['aria-current'] === 'step');
    expect(current).toHaveLength(1);
    expect(JSON.stringify(current[0]!.children.map((child) => (typeof child === 'string' ? child : child.props.children)))).toContain('Период');
  });

  it('shows no current step while a linked run is still loading', async () => {
    vi.mocked(api.getKnowledgeGenerationRun).mockReturnValue(new Promise(() => undefined));
    vi.mocked(api.listKnowledgeGenerationRuns).mockResolvedValue({ items: [], nextCursor: null });
    await act(async () => { renderer = create(wizard('run-1')); });
    expect(renderer!.root.findAll((node) => node.type === 'li' && node.props['aria-current'] !== undefined)).toHaveLength(0);
    expect(renderer!.root.findAll((node) => node.type === 'li' && String(node.props.className).includes('is-done'))).toHaveLength(0);
    expect(renderer!.root.findAll((node) => node.type === 'section' && node.props['aria-label'] === 'Период')).toHaveLength(0);
  });

  it('keeps one «Подробности разбора» block in the selection step, holding the run metrics', async () => {
    vi.mocked(api.getKnowledgeGenerationRun).mockResolvedValue(completedRun());
    vi.mocked(api.listKnowledgeGenerationRuns).mockResolvedValue({ items: [], nextCursor: null });
    await act(async () => { renderer = create(wizard('run-1')); });
    const output = JSON.stringify(renderer!.toJSON());
    expect(output).toContain('Отберите найденные факты');
    expect(output.match(/Подробности разбора/g)).toHaveLength(1);
    const details = renderer!.root.findAllByType('details').filter((node) => node.props.className === 'generation-details');
    expect(details).toHaveLength(1);
    expect(details[0]!.findAll((node) => node.props['aria-label'] === 'Статус разбора')).toHaveLength(1);
    expect(renderer!.root.findAll((node) => node.type === 'section' && node.props['aria-label'] === 'Статус разбора')).toHaveLength(1);
  });
});
