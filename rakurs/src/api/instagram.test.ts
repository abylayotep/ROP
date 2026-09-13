import { afterEach, expect, it, vi } from 'vitest';
import { connectInstagramAccount, listInstagramAccounts, setInstagramAccountEnabled } from './index';

afterEach(() => vi.unstubAllGlobals());

function respond(body: unknown) {
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(body), {
    status: 200, headers: { 'content-type': 'application/json' },
  }));
  vi.stubGlobal('window', { location: { origin: 'https://example.test' } });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

it('uses the owner-scoped Direct account routes', async () => {
  const fetch = respond([]);
  await listInstagramAccounts('agent 1');
  expect(String(fetch.mock.calls[0]?.[0])).toContain('/api/agents/agent%201/instagram');
  expect(fetch.mock.calls[0]?.[1]?.method).toBeUndefined();
});

it('sends a fresh short-lived token and exact selected account id', async () => {
  const fetch = respond({ account: null, choices: [] });
  await connectInstagramAccount('agent', 'short-token', 'ig-42');
  expect(String(fetch.mock.calls[0]?.[0])).toContain('/api/agents/agent/instagram/connect');
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
    accessToken: 'short-token', instagramAccountId: 'ig-42',
  });
});

it('patches enabled state without deleting the account', async () => {
  const fetch = respond({});
  await setInstagramAccountEnabled('agent', 'account-7', false);
  expect(String(fetch.mock.calls[0]?.[0])).toContain('/api/agents/agent/instagram/account-7');
  expect(fetch.mock.calls[0]?.[1]?.method).toBe('PATCH');
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({ enabled: false });
});
