import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createGraphClient,
  GraphError,
  REDACTED,
  withoutSecret,
} from '../src/lib/whatsapp/graph.js';

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
  vi.useRealTimers();
});

describe('graph client', () => {
  it('reads a phone number and returns what the cabinet shows', async () => {
    answerWith({ id: '136', display_phone_number: '+7 708 580 79 32', verified_name: 'Aisham' });

    const number = await client.getPhoneNumber('136', TOKEN);

    expect(number).toMatchObject({
      id: '136',
      displayPhoneNumber: '+7 708 580 79 32',
      verifiedName: 'Aisham',
    });
    expect(calls[0]!.url).toBe(
      'https://graph.facebook.com/v26.0/136?fields=id%2Cdisplay_phone_number%2Cverified_name%2Cplatform_type%2Cis_on_biz_app',
    );
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${TOKEN}`,
    );
  });

  it('subscribes the application to a WABA', async () => {
    answerWith({ success: true });

    await client.subscribeApp('932', TOKEN);

    expect(calls[0]!.url).toBe('https://graph.facebook.com/v26.0/932/subscribed_apps');
    expect(calls[0]!.init.method).toBe('POST');
  });

  it('sends text and returns the id WhatsApp assigned', async () => {
    answerWith({ messages: [{ id: 'wamid.OUT' }] });

    const sent = await client.sendText('136', TOKEN, '77771234567', 'Здравствуйте!');

    expect(sent).toEqual({ messageId: 'wamid.OUT' });
    expect(calls[0]!.url).toBe('https://graph.facebook.com/v26.0/136/messages');
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

  it('gives every call a deadline', async () => {
    answerWith({ messages: [{ id: 'wamid.OUT' }] });

    await client.sendText('136', TOKEN, '777', 'hi');

    // Meta is on the request path of an operator's action; a call with no deadline would
    // hold that request open until the browser gave up.
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('says Meta did not answer when the deadline passes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      }),
    );

    // A GraphError, not the raw TimeoutError: every caller branches on GraphError and puts
    // `message` on a Russian-speaking operator's screen.
    await expect(client.sendText('136', TOKEN, '777', 'hi')).rejects.toThrow(GraphError);
    await expect(client.sendText('136', TOKEN, '777', 'hi')).rejects.toThrow('Meta не ответила');
  });

  it('says Meta did not answer when the deadline passes while the body is read', async () => {
    // `fetch` resolves as soon as the headers arrive and the signal stays live after that,
    // so a large download passes its deadline here rather than on the request itself.
    const response = new Response(Buffer.from([1, 2, 3]), { status: 200 });
    Object.defineProperty(response, 'arrayBuffer', {
      value: async () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => response));

    await expect(client.downloadMedia('https://lookaside.fb/x', TOKEN)).rejects.toThrow(
      GraphError,
    );
    await expect(client.downloadMedia('https://lookaside.fb/x', TOKEN)).rejects.toThrow(
      'Meta не ответила',
    );
  });

  it('reports a non-JSON failure without pretending to know why', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>502</html>', { status: 502 })),
    );

    await expect(client.sendText('136', TOKEN, '777', 'hi')).rejects.toThrow('HTTP 502');
  });

  it('exchanges an Embedded Signup code for a business token, server-side', async () => {
    answerWith({ access_token: 'EAAB-business', token_type: 'bearer' });

    const issued = await client.exchangeCode('AQD-code', '1585667806534384', 'app-secret');

    expect(issued.token).toBe('EAAB-business');
    expect(calls[0]!.url).toBe(
      'https://graph.facebook.com/v26.0/oauth/access_token?client_id=1585667806534384&client_secret=app-secret&code=AQD-code',
    );
    // No bearer header: there is no token yet, and the secret is in the query by Meta's design.
    expect((calls[0]!.init.headers as Record<string, string>)?.Authorization).toBeUndefined();
  });

  it('turns the lifetime Meta states into the moment the token dies', async () => {
    // The configuration built from Meta's «60-day token» template answers with
    // `expires_in`. Without reading it nothing in the product knows the number has a
    // deadline, and the first sign of it is every send failing at once.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-11T09:00:00.000Z'));
    answerWith({ access_token: 'EAAB-business', token_type: 'bearer', expires_in: 5_184_000 });

    const issued = await client.exchangeCode('AQD-code', '1585667806534384', 'app-secret');

    expect(issued.expiresAt).toEqual(new Date('2026-11-10T09:00:00.000Z'));
  });

  it('reports no deadline when Meta names none', async () => {
    // A configuration without the 60-day variant issues a token that does not expire, and
    // a made-up deadline would warn an owner about a number that is working perfectly.
    answerWith({ access_token: 'EAAB-business', token_type: 'bearer' });

    const issued = await client.exchangeCode('AQD-code', '1585667806534384', 'app-secret');

    expect(issued.expiresAt).toBeNull();
  });

  it('reports no deadline when Meta says the lifetime is zero', async () => {
    // Meta writes `expires_in: 0` for a token that never expires. Read literally that is
    // «died at the moment it was issued», which would lock the number out on arrival.
    answerWith({ access_token: 'EAAB-business', token_type: 'bearer', expires_in: 0 });

    const issued = await client.exchangeCode('AQD-code', '1585667806534384', 'app-secret');

    expect(issued.expiresAt).toBeNull();
  });

  it('refuses a successful exchange whose body carries no token', async () => {
    answerWith({ token_type: 'bearer' });

    await expect(client.exchangeCode('AQD-code', '1585667806534384', 'app-secret')).rejects.toThrow(
      'Meta вернула ответ без токена',
    );
  });

  it('reads whether a number is on the phone app', async () => {
    answerWith({
      id: '136',
      display_phone_number: '+7 771 523 03 42',
      verified_name: 'Sealhouse',
      platform_type: 'CLOUD_API',
      is_on_biz_app: true,
    });

    const number = await client.getPhoneNumber('136', TOKEN);

    expect(number).toMatchObject({ platformType: 'CLOUD_API', isOnBizApp: true });
    expect(calls[0]!.url).toBe(
      'https://graph.facebook.com/v26.0/136?fields=id%2Cdisplay_phone_number%2Cverified_name%2Cplatform_type%2Cis_on_biz_app',
    );
  });

  it('lists the numbers of a WABA', async () => {
    answerWith({
      data: [
        { id: '136', display_phone_number: '+7 771 523 03 42', verified_name: 'Sealhouse', is_on_biz_app: true },
      ],
    });

    const numbers = await client.listPhoneNumbers('932', TOKEN);

    expect(numbers).toEqual([
      { id: '136', displayPhoneNumber: '+7 771 523 03 42', verifiedName: 'Sealhouse', platformType: null, isOnBizApp: true },
    ]);
    expect(calls[0]!.url).toBe(
      'https://graph.facebook.com/v26.0/932/phone_numbers?fields=id%2Cdisplay_phone_number%2Cverified_name%2Cplatform_type%2Cis_on_biz_app',
    );
  });

  it('requests a phone-app sync and returns the request id', async () => {
    answerWith({ messaging_product: 'whatsapp', request_id: 'req-1' });

    const result = await client.requestSmbAppData('136', TOKEN, 'history');

    expect(result).toEqual({ requestId: 'req-1' });
    expect(calls[0]!.url).toBe('https://graph.facebook.com/v26.0/136/smb_app_data');
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      messaging_product: 'whatsapp',
      sync_type: 'history',
    });
  });
});

describe('withoutSecret', () => {
  it('takes out the exact secret it was given', () => {
    expect(withoutSecret(`Malformed access token ${TOKEN}`, TOKEN)).toBe(
      `Malformed access token ${REDACTED}`,
    );
  });

  it('leaves the sentence alone when there is no secret to take out', () => {
    expect(withoutSecret('HTTP 502', '')).toBe('HTTP 502');
  });

  it('takes out an OpenRouter key that came back url-encoded', () => {
    // The exact match cannot see this one: the provider quoted the key inside a URL, so
    // every byte of it is there and none of them line up with the stored string.
    const key = 'sk-or-v1-abc/def';
    const said = 'No auth credentials found for sk-or-v1-abc%2Fdef';

    expect(withoutSecret(said, key)).toBe(`No auth credentials found for ${REDACTED}`);
  });

  it('takes out an OpenRouter key that came back truncated', () => {
    const key = 'sk-or-v1-0123456789abcdef';

    expect(withoutSecret('Rate limit for key sk-or-v1-01234567…', key)).toContain(REDACTED);
    expect(withoutSecret('Rate limit for key sk-or-v1-01234567…', key)).not.toContain('01234567');
  });

  it('leaves the bare word alone', () => {
    // A prefix on its own is not a key, and redacting it would hide the sentence that
    // tells the owner what shape their key should have.
    expect(withoutSecret('Ключ начинается с sk-or-', '')).toBe('Ключ начинается с sk-or-');
  });
});

describe('Direct user-token exchange', () => {
  const scopes = ['instagram_basic', 'instagram_manage_messages', 'pages_show_list',
    'pages_read_engagement', 'pages_manage_metadata'];

  it('checks app binding through a POST batch and extends the token without putting secrets in URLs', async () => {
    const responses = [
      new Response(JSON.stringify([{ code: 200, body: JSON.stringify({ data: {
        app_id: 'our-app', type: 'USER', is_valid: true, scopes,
      } }) }]), { status: 200 }),
      new Response(JSON.stringify({ access_token: 'extended-token', expires_in: 3600 }), { status: 200 }),
    ];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return responses.shift()!;
    }));
    const issued = await client.exchangeUserToken('short-token', 'our-app', 'app-secret');
    expect(issued.token).toBe('extended-token');
    expect(issued.hasPagesReadEngagement).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls.every(({ url, init }) => init.method === 'POST' && !url.includes('short-token') && !url.includes('app-secret'))).toBe(true);
    expect(String(calls[0]?.init.body)).toContain('short-token');
    expect(String(calls[1]?.init.body)).toContain('short-token');
  });

  it('rejects a token issued for another app before attempting the extension', async () => {
    answerWith([{ code: 200, body: JSON.stringify({ data: {
      app_id: 'foreign-app', type: 'USER', is_valid: true, scopes,
    } }) }]);
    await expect(client.exchangeUserToken('short-token', 'our-app', 'app-secret'))
      .rejects.toBeInstanceOf(GraphError);
    expect(calls).toHaveLength(1);
  });

  it('limits Page discovery to the intersection of granular grants', async () => {
    const responses = [
      new Response(JSON.stringify([{ code: 200, body: JSON.stringify({ data: {
        app_id: 'our-app', type: 'USER', is_valid: true, scopes,
        granular_scopes: [{ scope: 'pages_show_list', target_ids: ['123', '456'] },
          { scope: 'pages_read_engagement', target_ids: ['123'] },
          { scope: 'pages_manage_metadata', target_ids: ['123', '789'] }],
      } }) }]), { status: 200 }),
      new Response(JSON.stringify({ access_token: 'extended-token' }), { status: 200 }),
    ];
    vi.stubGlobal('fetch', vi.fn(async () => responses.shift()!));
    const issued = await client.exchangeUserToken('short-token', 'our-app', 'app-secret');
    expect(issued.grantedPageIds).toEqual(['123']);
    expect(JSON.stringify(issued)).not.toContain('456');
  });
  it('does not infer Page access when a required granular target is absent', async () => {
    const responses = [
      new Response(JSON.stringify([{ code: 200, body: JSON.stringify({ data: {
        app_id: 'our-app', type: 'USER', is_valid: true, scopes,
        granular_scopes: [{ scope: 'pages_show_list', target_ids: ['123'] },
          { scope: 'pages_read_engagement', target_ids: ['123'] }],
      } }) }]), { status: 200 }),
      new Response(JSON.stringify({ access_token: 'extended-token' }), { status: 200 }),
    ];
    vi.stubGlobal('fetch', vi.fn(async () => responses.shift()!));
    const issued = await client.exchangeUserToken('short-token', 'our-app', 'app-secret');
    expect(issued.grantedPageIds).toEqual([]);
  });
});
