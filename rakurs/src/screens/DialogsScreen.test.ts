import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import { describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ data: undefined as unknown }));
vi.mock('@/store/agent', () => ({ useAgent: () => ({ agent: { id: 'agent' }, role: 'owner' }) }));
vi.mock('@/hooks/usePollingApi', () => ({ usePollingApi: () => ({
  data: fixture.data, loading: fixture.data === undefined, refreshing: false, error: undefined, reload: () => undefined,
}) }));
import { closedReplyMessage, DialogsScreen, supportsFileSending } from './DialogsScreen';

describe('dialog history navigation', () => {
  it('links to knowledge instead of offering a history import in the inbox', () => {
    const html = renderToStaticMarkup(createElement(StaticRouter, { location: '/a/agent/dialogs' },
      createElement(DialogsScreen)));
    expect(html).not.toContain('Загрузить историю');
    expect(html).toContain('href="/a/agent/training?tab=teach"');
    expect(html).toContain('Обучение агента');
  });

  it('identifies WhatsApp dialog rows by formatted phone instead of contact name', () => {
    fixture.data = [{
      id: 'dialog-1', channel: 'whatsapp', contactAddress: '77012345678', contactName: 'Анна', contactPhone: '77012345678',
      lastMessageAt: null, preview: 'Здравствуйте', windowOpen: true, adHeadline: null,
    }];
    const html = renderToStaticMarkup(createElement(StaticRouter, { location: '/a/agent/dialogs' },
      createElement(DialogsScreen)));
    expect(html).toContain('+7 701 234 56 78');
    expect(html).not.toContain('Анна');
    expect(html).toContain('aria-label="Поиск диалогов"');
  });

  it('shows Instagram identity and channel in a dialog row', () => {
    fixture.data = [{
      id: 'dialog-2', channel: 'instagram', contactAddress: 'ig-user-42', contactName: 'Анна', contactPhone: null,
      lastMessageAt: null, preview: 'Здравствуйте', windowOpen: true, adHeadline: null,
    }];
    const html = renderToStaticMarkup(createElement(StaticRouter, { location: '/a/agent/dialogs' },
      createElement(DialogsScreen)));
    expect(html).toContain('@ig-user-42');
    expect(html).toContain('Instagram');
  });

  it('disables Instagram uploads and explains its closed response window', () => {
    expect(supportsFileSending('instagram')).toBe(false);
    expect(supportsFileSending('whatsapp')).toBe(true);
    expect(closedReplyMessage('instagram')).toContain('Окно ответа Instagram закрыто');
  });
});
