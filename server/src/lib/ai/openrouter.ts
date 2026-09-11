/**
 * Everything this product says to a model.
 *
 * It is an interface first and an implementation second, the same way the Graph client is:
 * a turn takes a `ModelClient`, so every test above this file injects `fakeModel` and the
 * suite never reaches the network, never spends a token and never depends on a live key.
 * `openrouter.test.ts` drives the real one against a stubbed `fetch`, because the header the
 * key travels in, the deadline and the redaction exist only here.
 */
import { withoutSecret } from '../whatsapp/graph.js';

const BASE = 'https://openrouter.ai/api/v1';

/**
 * Four times the Graph client's deadline. A model thinks for seconds where Meta answers in
 * milliseconds, and a turn runs on the inbound queue rather than on somebody's request — Meta
 * has already had its 200 and nobody is watching a spinner. Cutting a slow model off at
 * fifteen seconds would throw away answers that were arriving perfectly well.
 *
 * Exported so the test can pin the number rather than merely assert that some deadline exists.
 */
export const TIMEOUT_MS = 60_000;

/**
 * The models an owner may pick, with the line they read while picking.
 *
 * A free-text field would let an owner paste an id that does not exist and learn about it
 * from a customer's silence, so the choice is a list and this is it. Every id here was
 * checked against OpenRouter's own catalogue and every one of them honours
 * `response_format: { type: 'json_object' }`, which is what a turn depends on. Adding a
 * model is one edit to this array — and checking the id first is the point of the array.
 */
export const MODELS: readonly { id: string; label: string; description: string }[] = [
  {
    id: 'openai/gpt-4o-mini',
    label: 'GPT-4o mini',
    description: 'Быстрая и самая дешёвая. Хороший выбор, пока вы настраиваете инструкции.',
  },
  {
    id: 'google/gemini-2.5-flash',
    label: 'Gemini 2.5 Flash',
    description: 'Тоже быстрая и дешёвая, но помнит очень длинную переписку.',
  },
  {
    id: 'openai/gpt-4.1',
    label: 'GPT-4.1',
    description: 'Сильнее и дороже: точнее следует инструкциям в сложных диалогах.',
  },
  {
    id: 'google/gemini-2.5-pro',
    label: 'Gemini 2.5 Pro',
    description: 'Сильная модель с большим контекстом — для длинных диалогов и базы знаний.',
  },
  {
    id: 'anthropic/claude-sonnet-4.5',
    label: 'Claude Sonnet 4.5',
    description: 'Самая аккуратная в формулировках и в отказе выдумывать. Самая дорогая.',
  },
];

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompletionInput {
  /** Decrypted immediately before the call and never held anywhere else. */
  key: string;
  /** An OpenRouter model id, one of `MODELS`. */
  model: string;
  /** A string, because that is how the column stores it; parsed to a number here. */
  temperature: string;
  /** Optional provider-side output cap; existing callers remain uncapped. */
  maxTokens?: number;
  messages: ChatMessage[];
}

export interface CompletionUsage {
  promptTokens: number;
  completionTokens: number;
  /** US dollars, as a string, for the same reason an order's amount is one. */
  cost: string;
}

export interface Completion extends CompletionUsage {
  text: string;
}

export interface ModelClient {
  complete(input: CompletionInput): Promise<Completion>;
}

/**
 * A failed turn, in words an owner can read.
 *
 * `message` is Russian and safe to show; `detail` carries OpenRouter's own text for the reply
 * log, already passed through `withoutSecret`. Nothing here ever carries the key: OpenRouter
 * echoes a rejected credential back inside its error, and a reply log is read on a screen.
 */
export class ModelError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: string,
    readonly usage?: CompletionUsage,
  ) {
    super(message);
    this.name = 'ModelError';
  }
}

/** What to tell an owner for each way OpenRouter says no. */
function reason(status: number): string {
  if (status === 401 || status === 403) return 'OpenRouter не принял ключ.';
  if (status === 402) return 'На счёте OpenRouter закончились средства.';
  if (status === 404) return 'OpenRouter не знает такую модель.';
  if (status === 429) return 'Модель сейчас загружена, попробуйте позже.';
  if (status >= 500) return 'OpenRouter временно недоступен.';
  return 'OpenRouter отклонил запрос.';
}

/** Reads a rejected response into an error, with the raw body kept out of `message`. */
async function failure(response: Response, key: string): Promise<ModelError> {
  let raw = '';
  try {
    raw = await response.text();
  } catch {
    // The body went away with the connection. The status is still the whole story.
  }
  const parsed = ((): string => {
    try {
      const json = JSON.parse(raw) as { error?: { message?: string } };
      return json.error?.message ?? raw;
    } catch {
      // Not JSON — a gateway page. Keep the text, truncated, rather than invent a reason.
      return raw;
    }
  })();
  const detail = withoutSecret(parsed, key).slice(0, 500);
  return new ModelError(reason(response.status), response.status, detail || undefined);
}

/**
 * Runs one exchange with OpenRouter under a deadline, and makes every way it can fail a
 * `ModelError`.
 *
 * Node rejects an expired `AbortSignal.timeout` with a `TimeoutError` that is not a
 * `ModelError` and whose message is English; a turn branches on `ModelError` and writes
 * `message` into a reply log an owner reads. 504, because the request did leave this process.
 *
 * Everything else that escapes `fetch` — a name that will not resolve, a refused connection, a
 * TLS failure — arrives as a `TypeError`. A turn that saw one of those would treat it as a bug
 * in this process rather than as OpenRouter being unreachable, so it is wrapped too. This
 * client is the one whose failures a turn has to classify, and «unreachable» is a refusal an
 * owner can act on, not a stack trace.
 *
 * It wraps the whole exchange rather than the `fetch` alone: `fetch` resolves as soon as the
 * headers arrive, and a model streams its answer, so the deadline is most likely to pass
 * while the body is being read. Parsing sits inside it too, so a truncated body raises this
 * rather than a `SyntaxError` nobody expects.
 */
async function within<T>(key: string, exchange: () => Promise<T>): Promise<T> {
  try {
    return await exchange();
  } catch (error) {
    if (error instanceof ModelError) throw error;
    if ((error as { name?: string } | null)?.name === 'TimeoutError') {
      throw new ModelError(`Модель не ответила за ${Math.round(TIMEOUT_MS / 1000)} с.`, 504);
    }
    const detail = withoutSecret(String((error as { message?: string })?.message ?? error), key);
    throw new ModelError('Не удалось связаться с OpenRouter.', 502, detail.slice(0, 500));
  }
}

/**
 * OpenRouter's cost, in the shape the reply log's `numeric(12,8)` column will accept.
 *
 * Most models report a number, some a string, and the rest send `null` or nothing at all.
 * `String(null)` is `'null'` and `String(1e-7)` is `'1e-7'` — the column rejects both, and a
 * turn that produced a good answer must not fail over a number nobody is reading. A string is
 * passed through as it came, because that is already OpenRouter's own decimal notation.
 */
function asCost(value: number | string | null | undefined): string {
  if (value == null) return '0';
  if (typeof value === 'string') return value;
  return Number.isFinite(value) ? value.toFixed(8) : '0';
}

/** OpenRouter's answer, in the parts we read. Everything else is ignored on purpose. */
interface ChatResponse {
  choices?: { message?: { content?: string | null } }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cost?: number | string | null;
  };
}

export function createModelClient(): ModelClient {
  return {
    async complete({ key, model, temperature, maxTokens, messages }) {
      return within(key, async () => {
        const response = await fetch(`${BASE}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            temperature: Number(temperature),
            messages,
            ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
            // The one hint most OpenRouter models honour. The prompt asks for JSON in words
            // as well, because some ignore this field, and a turn retries once when the
            // answer will not parse. All three together are why the JSON approach holds
            // across a model list the owner controls.
            response_format: { type: 'json_object' },
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });

        if (!response.ok) throw await failure(response, key);

        const text = await response.text();
        let parsed: ChatResponse;
        try {
          parsed = JSON.parse(text) as ChatResponse;
        } catch {
          // A 200 that is not JSON is a proxy page in front of OpenRouter. A `SyntaxError`
          // here would reach a turn as an unexpected throw and be logged as a bug.
          throw new ModelError(
            'OpenRouter вернул ответ, который не удалось прочитать.',
            502,
            withoutSecret(text, key).slice(0, 500) || undefined,
          );
        }

        const usage = parsed.usage ?? {};
        const completionUsage: CompletionUsage = {
          promptTokens: usage.prompt_tokens ?? 0,
          completionTokens: usage.completion_tokens ?? 0,
          cost: asCost(usage.cost),
        };
        const content = parsed.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || content === '') {
          throw new ModelError('Модель вернула пустой ответ.', 502, undefined, completionUsage);
        }

        // Not every model reports every number, and a turn that produced a good answer must
        // not fail over a missing token count.
        return {
          text: content,
          ...completionUsage,
        };
      });
    },
  };
}
