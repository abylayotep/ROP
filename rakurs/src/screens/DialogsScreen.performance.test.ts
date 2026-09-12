import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import { describe, expect, it, vi } from 'vitest';

const fixtures = vi.hoisted(() => ({ messages: Array.from({ length: 10000 }, (_, index) => ({
  id: String(index), direction: 'in', author: 'contact', kind: 'image',
  body: `Message ${index}`, sentAt: '2026-09-12T00:00:00Z', hasMedia: true, mediaMime: 'image/jpeg',
})), conversations: Array.from({ length: 1000 }, (_, index) => ({
  id: `conversation-${index}`, contactPhone: `Phone ${index}`, preview: 'Preview',
})) }));
vi.mock('@/store/agent', () => ({ useAgent: () => ({ agent: { id: 'agent' }, role: 'owner' }) }));
vi.mock('@/components/lead/LeadPanel', () => ({ LeadPanel: () => null }));
vi.mock('@/components/lead/AiSwitch', () => ({ AiSwitch: () => null }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ ok: vi.fn(), fail: vi.fn() }) }));
vi.mock('@/hooks/usePollingApi', () => ({ usePollingApi: (_fetcher: unknown, deps: unknown[]) => ({
  data: typeof deps[1] === 'number' ? fixtures.conversations : {
    contactPhone: 'Customer', aiEnabled: true, windowOpen: true, messages: fixtures.messages,
  }, loading: false, refreshing: false, error: undefined, reload: () => undefined,
}) }));
import { DialogsScreen } from './DialogsScreen';

function render(query = '') {
  return renderToStaticMarkup(createElement(StaticRouter, {
    location: `/a/agent/dialogs?conversation=conversation-0${query}`,
  }, createElement(DialogsScreen)));
}

describe('large dialog rendering', () => {
  it('mounts only the latest message page and a bounded conversation list', () => {
    const html = render();
    expect((html.match(/id="message-/g) ?? []).length).toBe(60);
    expect(html).toContain('id="message-9999"');
    expect(html).not.toContain('id="message-0"');
    expect(html).not.toContain('Phone 100</span>');
    expect(html).toContain('Предыдущие сообщения');
    expect(html).toContain('Следующие диалоги');
  });
  it('keeps old source links available without mounting thousands of following messages', () => {
    const html = render('&message=100');
    expect(html).toContain('id="message-100"');
    expect((html.match(/id="message-/g) ?? []).length).toBe(60);
    expect(html).toContain('К последним сообщениям');
  });
  it('defers image downloads until they approach the viewport', () => {
    const html = render();
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('decoding="async"');
  });
});
