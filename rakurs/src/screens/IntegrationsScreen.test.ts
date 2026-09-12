import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ ok: vi.fn(), fail: vi.fn() }) }));
import { InstagramDirectCard, instagramDirectStatus } from './IntegrationsScreen';

const account = {
  id: 'account-1', instagramUserId: '1784', username: 'shop', enabled: true,
  subscribed: true, tokenExpiresAt: null,
};

describe('Instagram Direct connection status', () => {
  it('does not call an unsubscribed account ready', () => {
    expect(instagramDirectStatus({ ...account, subscribed: false })).toBe('Нужна переподписка на сообщения');
  });

  it('explains disabled and expired connections', () => {
    expect(instagramDirectStatus({ ...account, enabled: false })).toBe('Приём сообщений выключен');
    expect(instagramDirectStatus({ ...account, tokenExpiresAt: '2000-01-01T00:00:00.000Z' }))
      .toBe('Доступ Meta истёк — подключите аккаунт заново');
  });

  it('distinguishes configured code from verified live delivery', () => {
    expect(instagramDirectStatus(account)).toBe('Подключение настроено — проверьте входящим сообщением');
  });

  it('renders reconnect, disable, and account selection controls', () => {
    const connected = renderToStaticMarkup(createElement(InstagramDirectCard, {
      accounts: [account], setup: { appId: 'app' }, owner: true, agentId: 'agent', onChanged: vi.fn(),
    }));
    expect(connected).toContain('Переподключить');
    expect(connected).toContain('Выключить');
    expect(connected).toContain('поддерживаются текстовые сообщения');
  });
});
