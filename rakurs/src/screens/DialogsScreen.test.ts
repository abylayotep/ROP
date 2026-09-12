import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/store/agent', () => ({ useAgent: () => ({ agent: { id: 'agent' }, role: 'owner' }) }));
vi.mock('@/hooks/usePollingApi', () => ({ usePollingApi: () => ({
  data: undefined, loading: true, refreshing: false, error: undefined, reload: () => undefined,
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
});
