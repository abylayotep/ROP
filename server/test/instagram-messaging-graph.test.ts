import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInstagramMessagingClient } from '../src/lib/instagram/messaging-graph.js';

afterEach(() => vi.unstubAllGlobals());

describe('Instagram messaging Graph protocol', () => {
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
