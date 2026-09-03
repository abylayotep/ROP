/**
 * The real `createCapiClient`, driven directly.
 *
 * Everything downstream of this file injects `fakeCapi`, which is right for the queue's logic
 * and leaves the parts that only exist here — where the token travels, the deadline, the
 * redaction, the retryable/permanent split and the hand-built request body — exercised by
 * nothing at all. So they are tested here, against a stubbed `fetch`. No socket is opened.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CapiError, TIMEOUT_MS, createCapiClient } from '../src/lib/capi/client.js';
import { REDACTED } from '../src/lib/whatsapp/graph.js';
import { buildLead, buildPurchase, serialiseEvent } from '../src/lib/capi/events.js';

const client = createCapiClient();
const TOKEN = 'EAAG-secret-system-user-token';
const DATASET = '1234567890';

const purchase = serialiseEvent(
  buildPurchase({
    orderId: 'order-1',
    ctwaClid: 'clid-1',
    phone: '77015550000',
    // Deliberately a figure a double cannot hold exactly: this is what must survive the body.
    amount: '9007199254740993.99',
    currency: 'KZT',
    paidAt: new Date('2026-09-01T10:00:00Z'),
  }),
);

const lead = serialiseEvent(
  buildLead({
    conversationId: 'conversation-1',
    ctwaClid: 'clid-2',
    phone: '77015550001',
    occurredAt: new Date('2026-09-01T11:00:00Z'),
  }),
);

const input = {
  datasetId: DATASET,
  token: TOKEN,
  testEventCode: null,
  events: [purchase],
};

let calls: { url: string; init: RequestInit }[];

/** Stubs `fetch` with one answer, recording what it was asked. */
function answerWith(body: unknown, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

/** Runs a send that is expected to fail and hands the error back rather than throwing. */
const failure = (overrides: Partial<typeof input> = {}): Promise<unknown> =>
  client.send({ ...input, ...overrides }).catch((error: unknown) => error);

const sentBody = () => String(calls[0]!.init.body);
const sentJson = () => JSON.parse(sentBody()) as Record<string, unknown>;

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a send', () => {
  it('returns what Meta received and the trace id it answered with', async () => {
    answerWith({ events_received: 1, messages: [], fbtrace_id: 'A1bC2dE3' });

    expect(await client.send(input)).toEqual({ received: 1, fbtraceId: 'A1bC2dE3' });
  });

  it('posts to the dataset on the pinned Graph version', async () => {
    answerWith({ events_received: 1, fbtrace_id: 'x' });

    await client.send(input);

    expect(calls[0]!.url).toBe(`https://graph.facebook.com/v21.0/${DATASET}/events`);
    expect(calls[0]!.init.method).toBe('POST');
  });

  it('puts the token in the body and never in the query string', async () => {
    answerWith({ events_received: 1, fbtrace_id: 'x' });

    await client.send(input);

    // A query string reaches access logs, proxies and error reports; a body does not.
    expect(calls[0]!.url).not.toContain(TOKEN);
    expect(calls[0]!.url).not.toContain('access_token');
    expect(sentJson().access_token).toBe(TOKEN);
  });

  it('sends the stored bytes of every event without re-serialising them', async () => {
    answerWith({ events_received: 2, fbtrace_id: 'x' });

    await client.send({ ...input, events: [purchase, lead] });

    // The whole point of the branded body: the digits Postgres returned for the amount are
    // the digits in the request. `JSON.parse` here would turn them into a double, so the
    // assertion is on the raw text.
    expect(sentBody()).toContain(purchase);
    expect(sentBody()).toContain(lead);
    expect(sentBody()).toContain('"value":9007199254740993.99');
    expect(sentBody()).toBe(`{"data":[${purchase},${lead}],"access_token":"${TOKEN}"}`);
  });

  it('includes test_event_code when one is set and omits it when it is null', async () => {
    answerWith({ events_received: 1, fbtrace_id: 'x' });
    await client.send({ ...input, testEventCode: 'TEST12345' });
    expect(sentJson().test_event_code).toBe('TEST12345');

    calls = [];
    answerWith({ events_received: 1, fbtrace_id: 'x' });
    await client.send(input);
    // Absent, not null: Meta reads a present `test_event_code` as «route this to the test
    // console», and a null one is still present.
    expect(sentJson()).not.toHaveProperty('test_event_code');
  });

  it('reports no trace id rather than inventing one', async () => {
    answerWith({ events_received: 1 });

    expect(await client.send(input)).toEqual({ received: 1, fbtraceId: null });
  });
});

describe('a refusal', () => {
  it('is a CapiError with a Russian message and no token in the detail', async () => {
    // Meta echoes the rejected credential back inside its own error text.
    answerWith(
      {
        error: {
          message: `Invalid OAuth access token - ${TOKEN}`,
          type: 'OAuthException',
          code: 190,
          fbtrace_id: 'Zz9',
        },
      },
      400,
    );

    const error = (await failure()) as CapiError;

    expect(error).toBeInstanceOf(CapiError);
    expect(error.status).toBe(400);
    expect(error.message).toBe('Meta не приняла токен доступа.');
    expect(error.detail).toContain(REDACTED);
    expect(error.detail).not.toContain(TOKEN);
  });

  it('does not retry a token Meta will refuse just as firmly next time', async () => {
    answerWith({ error: { message: 'Invalid OAuth access token', code: 190 } }, 400);

    expect((await failure()) as CapiError).toMatchObject({ retryable: false });
  });

  it('does not retry a malformed event', async () => {
    answerWith(
      { error: { message: 'Invalid parameter', type: 'OAuthException', code: 100 } },
      400,
    );

    expect((await failure()) as CapiError).toMatchObject({ retryable: false });
  });

  it('retries a rate limit', async () => {
    answerWith({ error: { message: 'Too many calls', code: 613 } }, 429);

    expect((await failure()) as CapiError).toMatchObject({ retryable: true, status: 429 });
  });

  it('retries a rate limit Meta dressed up as a 400', async () => {
    // Meta answers HTTP 400 for several of its throttles, so the status alone would file a
    // wait-and-try-again as a permanent refusal and drop the sale.
    answerWith(
      { error: { message: 'Application request limit reached', type: 'OAuthException', code: 4 } },
      400,
    );

    expect((await failure()) as CapiError).toMatchObject({ retryable: true });
  });

  it('retries a server error', async () => {
    answerWith({ error: { message: 'An unknown error occurred', code: 1 } }, 500);

    expect((await failure()) as CapiError).toMatchObject({ retryable: true, status: 500 });
  });

  it('reports a body that is not JSON without pretending to know why', async () => {
    answerWith('<html>502 Bad Gateway</html>', 502);

    const error = (await failure()) as CapiError;

    expect(error).toBeInstanceOf(CapiError);
    expect(error.detail).toContain('502 Bad Gateway');
    expect(error.retryable).toBe(true);
  });
});

describe('an answer nobody can read', () => {
  it('is a CapiError rather than a SyntaxError', async () => {
    answerWith('<html>a proxy sat in front of Meta</html>', 200);

    const error = (await failure()) as CapiError;

    expect(error).toBeInstanceOf(CapiError);
    expect(error.message).toBe('Meta вернула ответ, который не удалось прочитать.');
    // A proxy page is a proxy page; the same request may well go through next time.
    expect(error.retryable).toBe(true);
  });
});

describe('a deadline', () => {
  it('is set on every request', async () => {
    answerWith({ events_received: 1, fbtrace_id: 'x' });

    await client.send(input);

    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    expect(TIMEOUT_MS).toBeGreaterThan(0);
  });

  it('says Meta did not answer rather than escaping as a DOMException', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      }),
    );

    const error = (await failure()) as CapiError;

    expect(error).toBeInstanceOf(CapiError);
    expect(error.message).toContain('Meta не ответила');
    expect(error.status).toBe(504);
    expect(error.retryable).toBe(true);
  });

  it('says the same when it expires while the body is being read', async () => {
    // `fetch` resolves as soon as the headers arrive and the signal stays live after that,
    // so the deadline can just as easily pass on the body as on the request.
    const response = new Response('{"events_received":1}', { status: 200 });
    Object.defineProperty(response, 'text', {
      value: async () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => response));

    const error = (await failure()) as CapiError;

    expect(error).toBeInstanceOf(CapiError);
    expect(error.message).toContain('Meta не ответила');
  });
});

describe('a network failure', () => {
  it('is a CapiError rather than escaping as a TypeError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );

    const error = (await failure()) as CapiError;

    expect(error).toBeInstanceOf(CapiError);
    expect(error.message).toBe('Не удалось связаться с Meta.');
    expect(error.status).toBe(502);
    // Unreachable now is not unreachable in five minutes.
    expect(error.retryable).toBe(true);
  });

  it('keeps the token out of a network failure it reports', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError(`connect ECONNREFUSED while sending ${TOKEN}`);
      }),
    );

    const error = (await failure()) as CapiError;

    expect(error.detail).not.toContain(TOKEN);
    expect(error.detail).toContain(REDACTED);
  });
});
