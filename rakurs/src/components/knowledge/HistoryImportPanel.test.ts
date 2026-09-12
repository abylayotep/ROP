import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { StaticRouter } from 'react-router-dom/server';
import type { WhatsappHistoryOverview } from '@rakurs/contract';

const fixture = vi.hoisted(() => ({ overview: undefined as WhatsappHistoryOverview | undefined }));
vi.mock('@/hooks/usePollingApi', () => ({ usePollingApi: () => ({
  data: fixture.overview, error: undefined, loading: false, refreshing: false, reload: () => undefined,
}) }));
import { HistoryImportPanel } from './HistoryImportPanel';

const render = (readOnly = false) => renderToStaticMarkup(
  createElement(StaticRouter, { location: '/a/agent/knowledge' },
    createElement(HistoryImportPanel, { agentId: 'agent', readOnly })),
);

describe('history import controls', () => {
  beforeEach(() => { fixture.overview = { connectedNumbers: 1, availableChats: 0, run: null }; });

  it('shows the unavailable initial-history explanation alongside the request button', () => {
    const html = render();
    expect(html).toContain('Загрузить историю');
    expect(html).toContain('Первичная история ещё не получена');
    expect(html).toContain('Последние 100');
    expect(html).toContain('Последние 200');
  });

  it('does not offer a history mutation to a read-only member', () => {
    const html = render(true);
    expect(html).not.toContain('Загрузить историю</button>');
    expect(html).not.toContain('Количество чатов для загрузки');
    expect(html).toContain('Обновить статус');
  });

  it('keeps an acknowledged request in waiting rather than claiming an import', () => {
    fixture.overview!.run = {
      id: 'run', status: 'waiting', limit: 100, totalChats: 3, requestedChats: 3,
      receivedChats: 0, receivedMessages: 0, failedChats: 0,
      startedAt: '2026-09-12T00:00:00Z', finishedAt: null, error: null,
    };
    const html = render();
    expect(html).toContain('Ждём историю от WhatsApp');
    expect(html).toContain('Запрос выполняется…');
    expect(html).not.toContain('Ответы с историей получены');
  });
});
