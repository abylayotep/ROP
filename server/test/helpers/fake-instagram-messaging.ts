import type { InstagramMessagingClient, MessagingAccount } from '../../src/lib/instagram/messaging-graph.js';

export interface FakeInstagramMessaging extends InstagramMessagingClient {
  calls: Array<{ method: keyof InstagramMessagingClient; args: unknown[] }>;
}

export function fakeInstagramMessaging(
  accounts: MessagingAccount[] = [{ instagramUserId: 'ig-business-1', username: 'shop', pageId: 'page-1', pageName: 'Shop', pageToken: 'page-secret' }],
  overrides: Partial<InstagramMessagingClient> = {},
): FakeInstagramMessaging {
  const calls: FakeInstagramMessaging['calls'] = [];
  const invoke = <K extends keyof InstagramMessagingClient>(method: K, fallback: (...args: unknown[]) => unknown) =>
    (async (...args: unknown[]) => {
      calls.push({ method, args });
      return ((overrides[method] ?? fallback) as (...values: unknown[]) => unknown)(...args);
    }) as InstagramMessagingClient[K];
  return {
    calls,
    discover: invoke('discover', async () => accounts),
    subscribe: invoke('subscribe', async () => undefined),
    sendText: invoke('sendText', async () => ({ messageId: `ig-mid-${calls.length}` })),
  };
}
