import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import { describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ data: undefined as unknown }));
vi.mock('@/store/agent', () => ({ useAgent: () => ({ agent: { id: 'agent' }, role: 'owner' }) }));
vi.mock('@/hooks/usePollingApi', () => ({ usePollingApi: () => ({
  data: fixture.data, loading: fixture.data === undefined, refreshing: false, error: undefined, reload: () => undefined,
}) }));
import { DialogsScreen } from './DialogsScreen';

describe('dialog history navigation', () => {
  it('links to knowledge instead of offering a history import in the inbox', () => {
    const html = renderToStaticMarkup(createElement(StaticRouter, { location: '/a/agent/dialogs' },
      createElement(DialogsScreen)));
    expect(html).not.toContain('Загрузить историю');
    expect(html).toContain('href="/a/agent/knowledge"');
    expect(html).toContain('База знаний');
  });

  it('identifies dialog rows by formatted phone instead of contact name', () => {
    fixture.data = [{
      id: 'dialog-1', contactName: 'Анна', contactPhone: '77012345678',
      lastMessageAt: null, preview: 'Здравствуйте', windowOpen: true, adHeadline: null,
    }];
    const html = renderToStaticMarkup(createElement(StaticRouter, { location: '/a/agent/dialogs' },
      createElement(DialogsScreen)));
    expect(html).toContain('+7 701 234 56 78');
    expect(html).not.toContain('Анна');
    expect(html).toContain('aria-label="Поиск диалогов по номеру"');
  });
});
