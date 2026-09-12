import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KbGenerationProposal, KbGenerationRunDetail } from '@/types';

const toast = vi.hoisted(() => ({ fail: vi.fn(), ok: vi.fn() }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => toast }));
import {
  createDraftFromPersistedSelection,
  patchGenerationProposal,
  ProposalWorkspace,
  persistProposalSelection,
} from './ProposalWorkspace';

const proposal = (overrides: Partial<KbGenerationProposal> = {}): KbGenerationProposal => ({
  id: 'proposal-1', revision: 4, kind: 'knowledge', path: 'Доставка', body: 'Доставка занимает два дня.',
  confidence: 'high', selected: true, status: 'pending', draftId: null, noteId: null, warnings: [], matches: [],
  sources: [{ conversationId: 'conversation-1', messageId: 'message-1', sentAt: '2026-09-11T10:00:00Z', excerpt: 'Когда привезёте?', available: true }],
  ...overrides,
});

const detail = {
  run: { id: 'run-1', status: 'completed' },
  proposals: { items: [proposal(), proposal({ id: 'script-1', kind: 'script', path: 'Приветствие', body: 'Здравствуйте, помогу выбрать.', selected: false })], nextCursor: null },
  drafts: [], draftsNextCursor: null,
  exclusions: [{ batchId: 'batch-1', ordinal: 2, classification: 'irrelevant', reason: 'Внутренняя переписка' }], exclusionsNextCursor: null,
  rawFindings: [{ id: 'raw-1', path: 'Доставка', body: 'Два дня', warnings: [], sources: [] }], rawFindingsNextCursor: null,
} as unknown as KbGenerationRunDetail;

const render = () => renderToStaticMarkup(createElement(StaticRouter, { location: '/a/agent/knowledge?generation=run-1' },
  createElement(ProposalWorkspace, { agentId: 'agent-1', detail, onChanged: () => undefined })));

beforeEach(() => toast.fail.mockReset());

describe('ProposalWorkspace', () => {
  it('uses persisted server selection and exposes grouped review and audit controls', () => {
    const html = render();
    expect(html).toContain('aria-label="Добавить Доставка в черновик"');
    expect(html).toContain('checked=""');
    expect(html).toContain('База знаний');
    expect(html).toContain('Скрипт продаж');
    expect(html).toContain('Выбрать видимые');
    expect(html).toContain('Очистить выбор');
    expect(html).toContain('1 источник');
    expect(html).toContain('Внутренняя переписка');
    expect(html).toContain('Исходные находки');
    expect(html).toContain('Собрать новый черновик');
  });

  it('persists an optimistic checkbox with its current revision and rolls back on failure', async () => {
    const transitions: boolean[] = [];
    const update = vi.fn().mockRejectedValue(new Error('conflict'));
    await expect(persistProposalSelection({
      agentId: 'agent-1', proposal: proposal({ selected: false }), selected: true, update,
      onOptimistic: (next) => transitions.push(next.selected),
      onCommitted: () => undefined,
      onRollback: (previous) => transitions.push(previous.selected),
    })).rejects.toThrow('conflict');

    expect(update).toHaveBeenCalledWith('agent-1', 'proposal-1', { revision: 4, selected: true });
    expect(transitions).toEqual([true, false]);
  });

  it('removes owner mutation controls in member read-only mode', () => {
    const html = renderToStaticMarkup(createElement(StaticRouter, { location: '/' }, createElement(ProposalWorkspace, {
      agentId: 'agent-1', detail, onChanged: () => undefined, readOnly: true,
    })));
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain('Собрать новый черновик');
    expect(html).not.toContain('Сохранить правки');
  });

  it('allows draft assembly to discover persisted selections on later proposal pages', () => {
    const pagedDetail = {
      ...detail,
      proposals: { items: [proposal({ selected: false })], nextCursor: '20' },
    } as KbGenerationRunDetail;
    const html = renderToStaticMarkup(createElement(StaticRouter, { location: '/' }, createElement(ProposalWorkspace, {
      agentId: 'agent-1', detail: pagedDetail, onChanged: () => undefined,
      onLoadAllProposals: async () => [proposal({ id: 'later', selected: true })],
    })));

    expect(html).toMatch(/<button[^>]*class="btn-accent"(?![^>]*disabled)[^>]*>Собрать новый черновик/);
  });

  it('saves inline edits and rejection with the proposal revision', async () => {
    const update = vi.fn().mockResolvedValue(proposal({ revision: 5, path: 'Оплата' }));
    await patchGenerationProposal('agent-1', proposal(), { path: 'Оплата', body: 'Оплата по ссылке.' }, update);
    await patchGenerationProposal('agent-1', proposal(), { status: 'rejected' }, update);

    expect(update).toHaveBeenNthCalledWith(1, 'agent-1', 'proposal-1', {
      revision: 4, path: 'Оплата', body: 'Оплата по ссылке.',
    });
    expect(update).toHaveBeenNthCalledWith(2, 'agent-1', 'proposal-1', { revision: 4, status: 'rejected' });
  });

  it('creates a draft from the complete persisted selection only', async () => {
    const create = vi.fn().mockResolvedValue({ draftId: 'draft-1' });
    const selected = proposal({ id: 'later', revision: 7, selected: true });
    const rejected = proposal({ id: 'rejected', selected: true, status: 'rejected' });
    await createDraftFromPersistedSelection('agent-1', 'run-1', [proposal({ selected: false }), selected, rejected], { later: 'note-2' }, create);

    expect(create).toHaveBeenCalledWith('agent-1', 'run-1', {
      proposalIds: ['later'],
      revisions: { later: 7 },
      updateTargets: { later: 'note-2' },
    });
  });
});
