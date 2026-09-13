import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  listRules: vi.fn(),
  getCommunicationStyle: vi.fn(),
}));
vi.mock('@/api', async (original) => ({
  ...(await original() as object),
  listRules: fixture.listRules,
  getCommunicationStyle: fixture.getCommunicationStyle,
}));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ ok: () => {}, fail: () => {} }) }));
// Runs every fetcher the tab mounts, so an owner-only route a non-owner would call shows up.
vi.mock('@/hooks/useApi', () => ({ useApi: (fetcher: (signal: AbortSignal) => Promise<unknown>) => {
  void fetcher(new AbortController().signal).catch(() => undefined);
  return { data: undefined, error: undefined, loading: true, reload: () => {} };
} }));

import { RepliesTab } from './RepliesTab';

beforeEach(() => {
  fixture.listRules.mockReset().mockResolvedValue([]);
  fixture.getCommunicationStyle.mockReset().mockResolvedValue({ preset: 'warm', preview: 'Здравствуйте!' });
});

describe('RepliesTab', () => {
  it('shows a non-owner the style card and never asks for rules', () => {
    const html = renderToStaticMarkup(createElement(RepliesTab, { agentId: 'agent-1', owner: false, onOpenCoach: () => {} }));
    expect(html).toContain('Стиль общения');
    expect(html).not.toContain('Правила');
    expect(html).not.toContain('Исправить конкретный ответ через тренера');
    expect(fixture.listRules).not.toHaveBeenCalled();
  });

  it('shows the owner the rules, the future-only note and the coach shortcut', () => {
    const html = renderToStaticMarkup(createElement(RepliesTab, { agentId: 'agent-1', owner: true, onOpenCoach: () => {} }));
    expect(html).toContain('Стиль общения');
    expect(html).toContain('Правила');
    expect(html).toContain('Изменения действуют только на будущие ответы.');
    expect(html).toContain('Исправить конкретный ответ через тренера');
    expect(fixture.listRules).toHaveBeenCalledWith('agent-1', expect.anything());
  });
});
