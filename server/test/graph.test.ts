import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGraphClient, GraphError } from '../src/lib/whatsapp/graph.js';

const client = createGraphClient();
const TOKEN = 'EAAG-token';

let calls: { url: string; init: RequestInit }[];

function answerWith(body: unknown, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('graph client', () => {
  it('reads a phone number and returns what the cabinet shows', async () => {
    answerWith({ id: '136', display_phone_number: '+7 708 580 79 32', verified_name: 'Aisham' });

    const number = await client.getPhoneNumber('136', TOKEN);

    expect(number).toEqual({
      id: '136',
      displayPhoneNumber: '+7 708 580 79 32',
      verifiedName: 'Aisham',
    });
    expect(calls[0]!.url).toBe(
      'https://graph.facebook.com/v21.0/136?fields=id%2Cdisplay_phone_number%2Cverified_name',
    );
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${TOKEN}`,
    );
  });

  it('subscribes the application to a WABA', async () => {
    answerWith({ success: true });

    await client.subscribeApp('932', TOKEN);

    expect(calls[0]!.url).toBe('https://graph.facebook.com/v21.0/932/subscribed_apps');
    expect(calls[0]!.init.method).toBe('POST');
  });

  it('sends text and returns the id WhatsApp assigned', async () => {
    answerWith({ messages: [{ id: 'wamid.OUT' }] });

    const sent = await client.sendText('136', TOKEN, '77771234567', 'Здравствуйте!');

    expect(sent).toEqual({ messageId: 'wamid.OUT' });
    expect(calls[0]!.url).toBe('https://graph.facebook.com/v21.0/136/messages');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '77771234567',
      type: 'text',
      text: { preview_url: false, body: 'Здравствуйте!' },
    });
  });

  it('reads a media descriptor', async () => {
    answerWith({ url: 'https://lookaside.fb/x', mime_type: 'image/jpeg', file_size: 1024 });

    expect(await client.getMediaUrl('media-1', TOKEN)).toEqual({
      url: 'https://lookaside.fb/x',
      mimeType: 'image/jpeg',
      fileSize: 1024,
    });
  });

  it('downloads a file with the token attached', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init: RequestInit = {}) => {
        calls.push({ url: String(url), init });
        return new Response(Buffer.from([1, 2, 3]), { status: 200 });
      }),
    );

    const bytes = await client.downloadMedia('https://lookaside.fb/x', TOKEN);

    expect([...bytes]).toEqual([1, 2, 3]);
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${TOKEN}`,
    );
  });

  it('turns a Meta error into one we can show and log', async () => {
    answerWith(
      { error: { message: 'Invalid OAuth access token.', code: 190, type: 'OAuthException' } },
      401,
    );

    await expect(client.getPhoneNumber('136', 'stale')).rejects.toThrow(GraphError);
    await expect(client.getPhoneNumber('136', 'stale')).rejects.toThrow(
      'Invalid OAuth access token.',
    );
  });

  it('reports a non-JSON failure without pretending to know why', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>502</html>', { status: 502 })),
    );

    await expect(client.sendText('136', TOKEN, '777', 'hi')).rejects.toThrow('HTTP 502');
  });
});
