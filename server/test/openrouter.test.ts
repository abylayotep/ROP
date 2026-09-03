/**
 * The real `createModelClient`, driven directly.
 *
 * Everything downstream of this file injects `fakeModel`, which is right for a turn's logic
 * and leaves the parts that only exist here — the header the key travels in, the deadline,
 * the redaction and the reading of `usage` — exercised by nothing at all. So they are tested
 * here, against a stubbed `fetch`. No socket is opened.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MODELS, ModelError, TIMEOUT_MS, createModelClient } from '../src/lib/ai/openrouter.js';
import { agents } from '../src/db/schema.js';

const client = createModelClient();
const KEY = 'sk-or-v1-secret-key';

const input = {
  key: KEY,
  model: 'openai/gpt-4o-mini',
  temperature: '0.30',
  messages: [
    { role: 'system' as const, content: 'Ты продавец дверей.' },
    { role: 'user' as const, content: 'Сколько стоит?' },
  ],
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

const completion = (content: string, usage?: Record<string, unknown>) => ({
  choices: [{ message: { role: 'assistant', content } }],
  ...(usage ? { usage } : {}),
});

/** Runs a call that is expected to fail and hands the error back rather than throwing. */
const failure = (): Promise<unknown> => client.complete(input).catch((error: unknown) => error);

const body = () => JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a completion', () => {
  it('returns the text, the token counts and the cost OpenRouter reported', async () => {
    answerWith(
      completion('{"reply":"Двери от 90 000 ₸."}', {
        prompt_tokens: 812,
        completion_tokens: 34,
        cost: '0.00042100',
      }),
    );

    const answer = await client.complete(input);

    expect(answer).toEqual({
      text: '{"reply":"Двери от 90 000 ₸."}',
      promptTokens: 812,
      completionTokens: 34,
      cost: '0.00042100',
    });
  });

  it('defaults the counts and the cost when the model reported no usage at all', async () => {
    answerWith(completion('{"reply":"Да."}'));

    const answer = await client.complete(input);

    expect(answer).toEqual({
      text: '{"reply":"Да."}',
      promptTokens: 0,
      completionTokens: 0,
      cost: '0',
    });
  });

  it('counts the tokens of a model that reports usage but no cost', async () => {
    answerWith(completion('{"reply":"Да."}', { prompt_tokens: 41, completion_tokens: 7 }));

    const answer = await client.complete(input);

    expect(answer).toMatchObject({ promptTokens: 41, completionTokens: 7, cost: '0' });
  });

  it('writes a numeric cost as a decimal the numeric(12,8) column will take', async () => {
    // `String(1e-7)` is the string `1e-7`, which that column rejects. Most models report the
    // cost as a number, and the small ones report numbers this small.
    answerWith(completion('{}', { prompt_tokens: 3, completion_tokens: 1, cost: 0.0000001 }));

    const answer = await client.complete(input);

    expect(answer.cost).toBe('0.00000010');
    expect(answer.cost).not.toContain('e');
  });

  it('survives a model that sends a null cost', async () => {
    // `String(null)` is the string `null`, and a turn that produced a good answer must not
    // fail on the reply log over a number nobody reads.
    answerWith(
      completion('{"reply":"Да."}', { prompt_tokens: 9, completion_tokens: 2, cost: null }),
    );

    const answer = await client.complete(input);

    expect(answer).toMatchObject({ promptTokens: 9, cost: '0' });
  });

  it('sends the key as a bearer token and the model, temperature and messages in the body', async () => {
    answerWith(completion('{}'));

    await client.complete(input);

    expect(calls[0]!.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(calls[0]!.init.method).toBe('POST');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(body()).toMatchObject({
      model: 'openai/gpt-4o-mini',
      temperature: 0.3,
      messages: input.messages,
      response_format: { type: 'json_object' },
    });
  });

  it('carries the sixty-second deadline on the request', async () => {
    answerWith(completion('{}'));
    const deadline = vi.spyOn(AbortSignal, 'timeout');

    await client.complete(input);

    expect(deadline).toHaveBeenCalledWith(TIMEOUT_MS);
    expect(TIMEOUT_MS).toBe(60_000);
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    deadline.mockRestore();
  });
});

describe('a failure', () => {
  it('raises a Russian ModelError when the answer carries no choices', async () => {
    answerWith({ choices: [] });

    const error = await failure();

    expect(error).toBeInstanceOf(ModelError);
    expect((error as ModelError).message).toMatch(/[а-яё]/i);
  });

  it('raises a Russian ModelError when the one choice carries no content', async () => {
    answerWith({ choices: [{ message: { role: 'assistant' } }] });

    const error = await failure();

    expect(error).toBeInstanceOf(ModelError);
    expect((error as ModelError).message).toMatch(/[а-яё]/i);
  });

  it('never lets the key out through a rejected request', async () => {
    // OpenRouter echoes the credential it refused, the way Meta echoes a bad token.
    answerWith({ error: { message: `No auth credentials found: ${KEY}` } }, 401);

    const error = await failure();

    expect(error).toBeInstanceOf(ModelError);
    expect((error as ModelError).status).toBe(401);
    expect((error as ModelError).message).not.toContain(KEY);
    expect((error as ModelError).message).toMatch(/[а-яё]/i);
    expect(String((error as ModelError).detail ?? '')).not.toContain(KEY);
  });

  it('says in Russian that the model is busy on a 429', async () => {
    answerWith({ error: { message: 'Rate limit exceeded' } }, 429);

    const error = await failure();

    expect(error).toBeInstanceOf(ModelError);
    expect((error as ModelError).status).toBe(429);
    expect((error as ModelError).message).toMatch(/[а-яё]/i);
    expect((error as ModelError).message).not.toMatch(/Rate limit/);
  });

  it('raises a ModelError rather than a SyntaxError when a 200 body is not JSON', async () => {
    answerWith(`<html><title>502 Bad Gateway</title><!-- ${KEY} --></html>`);

    const error = await failure();

    expect(error).toBeInstanceOf(ModelError);
    expect(error).not.toBeInstanceOf(SyntaxError);
    expect((error as ModelError).status).toBe(502);
    expect((error as ModelError).message).toMatch(/[а-яё]/i);
    expect((error as ModelError).detail).toContain('Bad Gateway');
    expect((error as ModelError).detail).not.toContain(KEY);
  });

  it('raises a ModelError rather than a SyntaxError when a failing body is not JSON', async () => {
    answerWith('<html><title>504 Gateway Timeout</title></html>', 504);

    const error = await failure();

    expect(error).toBeInstanceOf(ModelError);
    expect((error as ModelError).status).toBe(504);
  });

  it('turns an expired deadline into a ModelError rather than a DOMException', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        // What Node throws for `AbortSignal.timeout`: a DOMException named TimeoutError.
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      }),
    );

    const error = await failure();

    expect(error).toBeInstanceOf(ModelError);
    expect((error as ModelError).status).toBe(504);
    expect((error as ModelError).message).toMatch(/[а-яё]/i);
  });

  it('turns a deadline that expires while the body is read into a ModelError', async () => {
    // The whole exchange is under the deadline, not the fetch alone: a model streams its
    // answer, so the body is exactly where the deadline is most likely to pass.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              pull() {
                throw new DOMException('aborted due to timeout', 'TimeoutError');
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );

    const error = await failure();

    expect(error).toBeInstanceOf(ModelError);
    expect((error as ModelError).status).toBe(504);
  });

  it('turns an unreachable OpenRouter into a ModelError rather than a TypeError', async () => {
    // What `fetch` throws for a name that will not resolve or a refused connection. A turn
    // branches on ModelError, so an escaping TypeError would be logged as a bug in us.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );

    const error = await failure();

    expect(error).toBeInstanceOf(ModelError);
    expect((error as ModelError).status).toBe(502);
    expect((error as ModelError).message).toMatch(/[а-яё]/i);
  });

  it('keeps the key out of an error thrown by fetch itself', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError(`request to https://openrouter.ai failed, key=${KEY}`);
      }),
    );

    const error = await failure();

    expect((error as ModelError).message).not.toContain(KEY);
    expect(String((error as ModelError).detail ?? '')).not.toContain(KEY);
  });
});

describe('the model list', () => {
  it('offers the model the schema starts an agent on', () => {
    // Task 1 defaults `agents.model` to an id, and an owner who never opens the picker runs
    // on it. If it drifted out of this list, the picker would open on nothing.
    expect(MODELS.map((m) => m.id)).toContain(agents.model.default);
  });

  it('offers models an owner may pick', () => {
    expect(MODELS.length).toBeGreaterThan(0);

    for (const model of MODELS) {
      expect(model.id, model.id).toContain('/');
      expect(model.label.length, model.id).toBeGreaterThan(0);
      expect(model.description.length, model.id).toBeGreaterThan(0);
    }
  });

  it('lists every model once', () => {
    expect(new Set(MODELS.map((m) => m.id)).size).toBe(MODELS.length);
  });
});
