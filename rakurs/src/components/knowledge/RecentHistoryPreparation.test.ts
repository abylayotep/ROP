import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import type { KbGenerationPreview } from '@/types';
import { StaticRouter } from 'react-router-dom/server';

const fixture = vi.hoisted(() => ({ data: undefined as unknown, error: undefined as unknown }));
vi.mock('@/hooks/usePollingApi', () => ({ usePollingApi: () => ({
  data: fixture.data, error: fixture.error, loading: false, refreshing: false, reload: () => undefined,
}) }));
import { RecentHistoryPreparation, loadRecentHistoryPreparation } from './RecentHistoryPreparation';
import { ChatGenerationPanel } from './ChatGenerationPanel';

const preview = { previewId: 'preview', counts: { selectedMessages: 2807, eligibleMessages: 2100,
  skippedAiOrSystem: 0, skippedUnsupported: 707, skippedEmpty: 0, skippedSensitive: 0,
  skippedOversize: 0, skippedNoSeller: 0 }, truncated: false, modelId: 'model', maxCalls: 20,
  maxOutputTokens: 2000 } as KbGenerationPreview;
const render = () => renderToStaticMarkup(createElement(RecentHistoryPreparation, { agentId: 'agent', busy: false, onStart: () => undefined }));

beforeEach(() => { fixture.error = undefined; fixture.data = { preview, conversations: 78, from: '2026-08-30', to: '2026-09-13' }; });

it('shows one preparation action and clear coverage instead of manual chat selection', () => {
  const html = render();
  expect(html).toContain('Подготовить базу знаний и скрипт');
  expect(html).toContain('2');
  expect(html).toContain('707');
  expect(html).not.toContain('type="checkbox"');
  expect(html).not.toContain('type="date"');
  expect(html).not.toContain('Выбрать последние');
});

it('does not allow a failed or truncated preview to start paid generation', () => {
  fixture.error = new Error('Preview unavailable');
  expect(render()).toMatch(/disabled=""[^>]*>Подготовить/);
  fixture.error = undefined;
  fixture.data = { preview: { ...preview, truncated: true }, conversations: 78, from: '2026-08-30', to: '2026-09-13' };
  expect(render()).toMatch(/disabled=""[^>]*>Подготовить/);
});

it('includes every returned conversation without silently slicing to 100 or 200', async () => {
  const ids = Array.from({ length: 205 }, (_, index) => `chat-${index}`);
  let selected: string[] = [];
  const result = await loadRecentHistoryPreparation('agent', new AbortController().signal, {
    list: async () => ids.map(id => ({ id })),
    preview: async (_agentId, selection) => { selected = selection.conversationIds; return preview; },
  }, new Date(2026, 8, 12, 12));
  expect(selected).toEqual(ids);
  expect(result.from).toBe('2026-08-30');
  expect(result.to).toBe('2026-09-13');
});

it('uses the simplified flow in the actual generation panel and preserves read-only access', () => {
  const panel = (readOnly: boolean) => renderToStaticMarkup(createElement(StaticRouter, { location: '/' },
    createElement(ChatGenerationPanel, { agentId: 'agent', initialRunId: null, onRunId: () => undefined, readOnly })));
  expect(panel(false)).toContain('Подготовить базу знаний и скрипт');
  expect(panel(false)).not.toContain('Выбрать последние');
  expect(panel(false)).not.toContain('Проверить объём');
  expect(panel(true)).not.toContain('Подготовить базу знаний и скрипт');
});
