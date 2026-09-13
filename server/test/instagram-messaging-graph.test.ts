import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInstagramMessagingClient, InstagramMessagingError } from '../src/lib/instagram/messaging-graph.js';

afterEach(() => vi.unstubAllGlobals());

describe('Instagram messaging Graph protocol', () => {
  it('discovers only an approved Page when me/accounts is empty', async () => {
    const fetch = vi.fn(async (url: string | URL | Request) => new Response(JSON.stringify(
      String(url).includes('/me/accounts') ? { data: [] } : { id: '123', name: 'Approved',
        access_token: 'page-secret', instagram_business_account: { id: 'ig-1', username: 'sealhouse.kz' } }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const diagnostics: unknown[] = [];
    const accounts = await createInstagramMessagingClient().discover('user-token',
      (item) => diagnostics.push(item), ['123']);
    expect(accounts).toEqual([{ instagramUserId: 'ig-1', username: 'sealhouse.kz',
      pageId: '123', pageName: 'Approved', pageToken: 'page-secret' }]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(fetch.mock.calls[1]?.[0])).toContain('/123?fields=');
    expect(String(fetch.mock.calls[1]?.[0])).not.toContain('tasks');
    expect(JSON.stringify(diagnostics)).not.toMatch(/page-secret|ig-1|123/);
  });
  it('does not query an unapproved Page or accept a mismatched Page response', async () => {
    const fetch = vi.fn(async (url: string | URL | Request) => new Response(JSON.stringify(
      String(url).includes('/me/accounts') ? { data: [] } : { id: '456', access_token: 'page-secret',
        instagram_business_account: { id: 'ig-1' } }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    expect(await createInstagramMessagingClient().discover('user-token', undefined, [])).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await createInstagramMessagingClient().discover('user-token', undefined, ['123'])).toEqual([]);
  });
  it('keeps an authorized Page when another approved Page is unavailable', async () => {
    const fetch = vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      if (path.includes('/me/accounts')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      if (path.includes('/111?')) return new Response(JSON.stringify({ error: { code: 100 } }), { status: 400 });
      return new Response(JSON.stringify({ id: '222', access_token: 'page-secret',
        instagram_business_account: { id: 'ig-2', username: 'approved' } }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetch);
    const accounts = await createInstagramMessagingClient().discover('user-token', undefined, ['111', '222']);
    expect(accounts.map((account) => account.instagramUserId)).toEqual(['ig-2']);
  });
  it('does not hide an expired token as a missing Page', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => new Response(JSON.stringify(
      String(url).includes('/me/accounts') ? { data: [] } : { error: { code: 190, error_subcode: 463 } }),
    { status: String(url).includes('/me/accounts') ? 200 : 400 })));
    await expect(createInstagramMessagingClient().discover('user-token', undefined, ['123']))
      .rejects.toMatchObject({ status: 400, code: 190, subcode: 463 });
  });
  it('rejects excessive fallback requests before contacting Page endpoints', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    await expect(createInstagramMessagingClient().discover('user-token', undefined,
      Array.from({ length: 21 }, (_, index) => String(index + 1)))).rejects.toMatchObject({ status: 400 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('reports discovery filters without logging account identifiers or tokens', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [{
      id: 'private-page', name: 'Private Page', access_token: 'private-token',
      tasks: ['PROFILE_PLUS_FULL_CONTROL'], instagram_business_account: { id: 'private-ig', username: 'private-user' },
    }] }), { status: 200 })));
    const diagnostics: unknown[] = [];
    await createInstagramMessagingClient().discover('user-token', (diagnostic) => diagnostics.push(diagnostic));
    expect(diagnostics).toEqual([{
      pageCount: 1, pagesWithToken: 1, pagesWithInstagram: 1,
      pagesWithMessagingTask: 0, taskNames: ['PROFILE_PLUS_FULL_CONTROL'], fallbackCount: 0,
    }]);
    expect(JSON.stringify(diagnostics)).not.toMatch(/private-page|private-token|private-ig|private-user/);
  });
  it('retains numeric Meta diagnostics without needing to expose the provider message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: {
      message: 'page-secret', code: 10, error_subcode: 2018304,
    } }), { status: 403 })));
    await expect(createInstagramMessagingClient().discover('user-token')).rejects.toMatchObject({
      name: InstagramMessagingError.name, status: 403, code: 10, subcode: 2018304,
    });
  });

  it('verifies that this application owns the messages subscription', async () => {
    const responses = [
      new Response(JSON.stringify({ success: true }), { status: 200 }),
      new Response(JSON.stringify({ data: [{ id: 'another-app', subscribed_fields: ['messages'] }] }), { status: 200 }),
    ];
    vi.stubGlobal('fetch', vi.fn(async () => responses.shift()!));
    await expect(createInstagramMessagingClient().subscribe('page-1', 'secret', 'our-app'))
      .rejects.toThrow('активную подписку');
  });

  it('sends a response through the Page endpoint with the Instagram-scoped recipient', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ message_id: 'mid-1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    await createInstagramMessagingClient().sendText('page-1', 'secret', 'igsid-1', 'Hello');
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toContain('/page-1/messages');
    expect(JSON.parse(init!.body as string)).toEqual({
      recipient: { id: 'igsid-1' }, messaging_type: 'RESPONSE', message: { text: 'Hello' },
    });
  });
});
