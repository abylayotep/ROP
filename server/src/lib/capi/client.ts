/**
 * Everything this product says to Meta's Conversions API.
 *
 * It is an interface first and an implementation second, the same way the Graph client and
 * the model client are: the queue takes a `CapiClient`, so every test above this file injects
 * `fakeCapi` and the suite never reaches the network, never spends a real dataset's quota and
 * never depends on a live token. `capi-client.test.ts` drives the real one against a stubbed
 * `fetch`, because the body, the deadline, the redaction and the retryable/permanent split
 * exist only here.
 */
import type { CapiEventBody } from './events.js';
import { GRAPH_ROOT, withoutSecret } from '../whatsapp/graph.js';

/**
 * The same fifteen seconds the Graph client gives Meta.
 *
 * This one runs on the queue drain rather than on somebody's request, so nothing is waiting
 * on a screen — but a drain that hangs holds the pass open behind it, and Meta answers this
 * endpoint in milliseconds when it answers at all. Exported so the test can pin the number
 * rather than merely assert that some deadline exists.
 */
export const TIMEOUT_MS = 15_000;

export interface CapiSend {
  /** Meta's dataset (pixel) id, from `capi_settings`. */
  datasetId: string;
  /** Decrypted immediately before the call and never held anywhere else. */
  token: string;
  /** Set while an owner is watching Meta's test console; null in normal operation. */
  testEventCode: string | null;
  /**
   * Not `unknown[]` and not objects: these are the exact bytes `serialiseEvent` produced and
   * `capi_events.payload` stored. See `requestBody` for why the type matters.
   */
  events: readonly CapiEventBody[];
}

export interface CapiResult {
  /** Meta's `events_received`. One send can carry several events. */
  received: number;
  /** Meta's `fbtrace_id`, stored so a disagreement with Meta has a reference. */
  fbtraceId: string | null;
}

export interface CapiClient {
  send(input: CapiSend): Promise<CapiResult>;
}

/**
 * A refusal from Meta, in words an owner can read, plus the one fact the queue needs.
 *
 * `message` is Russian and safe to show; `detail` carries Meta's own text for the event log,
 * already passed through `withoutSecret`. Nothing here ever carries the token: Meta echoes a
 * rejected credential back inside its error message, and the event log is read on a screen
 * and stored in a column.
 *
 * `retryable` is what the queue branches on. Everything else in this class is for a human.
 */
export class CapiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'CapiError';
  }
}

/**
 * Meta's error codes that mean «not now», as opposed to «not ever».
 *
 * 1 and 2 are its own unspecified and temporary failures — the text literally asks for a
 * retry. 4, 17, 32 and 613 are the four throttles: per application, per user, per page and
 * per API. 80004 is the Conversions API's own rate limit. Every one of them describes a
 * condition that passes on its own, so the queue waits and sends the same bytes again.
 *
 * These are listed by code rather than inferred from the status because Meta answers HTTP
 * 400 for several of its throttles. Classifying on the status alone would file a
 * wait-a-minute as a permanent refusal and drop a sale that was going to be reported fine.
 */
const TRANSIENT_CODES = new Set([1, 2, 4, 17, 32, 613, 80004]);

/**
 * Meta's error codes that will say exactly the same thing on the fifth attempt.
 *
 * 190 is a token that is invalid, expired or revoked; 100 is a parameter Meta will not
 * accept — a dataset id that is not ours, or an event whose shape it rejects; 200 and 10 are
 * permissions the system user does not have; 803 is an object that does not exist. None of
 * these is fixed by waiting: they are fixed by an owner changing something on the settings
 * screen, which is why task 4 stops immediately and shows `message` rather than burning the
 * retry budget in silence.
 */
const PERMANENT_CODES = new Set([10, 100, 190, 200, 803]);

/**
 * Codes first, then the status.
 *
 * The codes are the sharper signal in both directions — they rescue a throttle Meta dressed
 * up as a 400, and they condemn a bad token that arrived with some other status. The status
 * is the fallback for everything Meta did not label: 408 and 429 are explicitly «later», 5xx
 * is Meta being unwell, and any other 4xx is us being wrong about something.
 */
function isRetryable(status: number, code: number | undefined): boolean {
  if (code !== undefined && TRANSIENT_CODES.has(code)) return true;
  if (code !== undefined && PERMANENT_CODES.has(code)) return false;
  return status === 408 || status === 429 || status >= 500;
}

/** What to tell an owner for each way Meta says no. */
function reason(status: number, code: number | undefined): string {
  if (code === 190 || status === 401 || status === 403) return 'Meta не приняла токен доступа.';
  if (code === 10 || code === 200) return 'У системного пользователя нет прав на этот набор.';
  if ((code !== undefined && TRANSIENT_CODES.has(code) && code > 2) || status === 429) {
    return 'Meta ограничила частоту запросов, попробуем позже.';
  }
  if (status === 404 || code === 803) return 'Meta не нашла такой набор данных.';
  if (status >= 500 || code === 1 || code === 2) return 'Meta временно недоступна.';
  return 'Meta отклонила событие.';
}

/** Meta's error envelope, in the parts we read. */
interface MetaError {
  error?: { message?: string; type?: string; code?: number };
}

/** Reads a rejected response into an error, with the raw body kept out of `message`. */
async function failure(response: Response, token: string): Promise<CapiError> {
  let raw = '';
  try {
    raw = await response.text();
  } catch {
    // The body went away with the connection. The status is still the whole story.
  }

  let code: number | undefined;
  let text = raw;
  try {
    const parsed = JSON.parse(raw) as MetaError;
    code = parsed.error?.code;
    text = parsed.error?.message ?? raw;
  } catch {
    // Not JSON — a gateway page in front of Meta. Keep the text rather than invent a reason.
  }

  const detail = withoutSecret(text, token).slice(0, 500);
  return new CapiError(
    reason(response.status, code),
    response.status,
    isRetryable(response.status, code),
    detail || undefined,
  );
}

/**
 * Runs one exchange with Meta under a deadline, and makes every way it can fail a `CapiError`.
 *
 * Node rejects an expired `AbortSignal.timeout` with a `TimeoutError` that is not a
 * `CapiError` and whose message is English; the queue branches on `CapiError` and writes
 * `message` into an event log an owner reads. 504, because the request did leave this process
 * — which is also why it is retryable: Meta may well have taken the event, and `event_id`
 * makes a second attempt free.
 *
 * Everything else that escapes `fetch` — a name that will not resolve, a refused connection, a
 * TLS failure — arrives as a `TypeError`. The queue would treat one of those as a bug in this
 * process rather than as Meta being unreachable, and would have no `retryable` to read, so it
 * is wrapped too.
 *
 * It wraps the whole exchange rather than the `fetch` alone: `fetch` resolves as soon as the
 * headers arrive and the signal stays live after that, so the deadline can pass on the body
 * read. Parsing sits inside it as well, so a truncated or non-JSON answer raises this rather
 * than a `SyntaxError` nobody expects.
 */
async function within<T>(token: string, exchange: () => Promise<T>): Promise<T> {
  try {
    return await exchange();
  } catch (error) {
    if (error instanceof CapiError) throw error;
    if ((error as { name?: string } | null)?.name === 'TimeoutError') {
      throw new CapiError(`Meta не ответила за ${Math.round(TIMEOUT_MS / 1000)} с.`, 504, true);
    }
    const detail = withoutSecret(String((error as { message?: string })?.message ?? error), token);
    throw new CapiError('Не удалось связаться с Meta.', 502, true, detail.slice(0, 500));
  }
}

/**
 * The request body, assembled by concatenating strings rather than by `JSON.stringify`.
 *
 * This looks like the wrong tool and is the right one. Every member of `events` is already
 * finished JSON — the exact bytes `serialiseEvent` wrote and `capi_events.payload` stored,
 * with the order's amount carried as the digits Postgres returned. `JSON.stringify({ data:
 * events })` would quote those strings into one long string field, and `JSON.parse` first to
 * avoid that would turn `9007199254740993.99` into the nearest double and send a different
 * number than the customer paid. Neither is acceptable, so the members are spliced in as
 * they stand and only the two values this function owns — the test code and the token — go
 * through `JSON.stringify`, which is what escapes them correctly.
 *
 * `test_event_code` is omitted rather than sent as null: Meta reads a present field as
 * «route this to the test console», and a null one is still present.
 */
function requestBody(input: CapiSend): string {
  const data = `"data":[${input.events.join(',')}]`;
  const test =
    input.testEventCode === null
      ? ''
      : `,"test_event_code":${JSON.stringify(input.testEventCode)}`;
  // In the body and not in the query string: a query string reaches access logs, proxies and
  // anything that reports a failing URL, and this one would carry a system user's token.
  const token = `,"access_token":${JSON.stringify(input.token)}`;

  return `{${data}${test}${token}}`;
}

/** Meta's answer, in the parts we read. Everything else is ignored on purpose. */
interface EventsResponse {
  events_received?: number;
  fbtrace_id?: string;
}

export function createCapiClient(): CapiClient {
  return {
    async send(input) {
      return within(input.token, async () => {
        const response = await fetch(
          `${GRAPH_ROOT}/${encodeURIComponent(input.datasetId)}/events`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: requestBody(input),
            signal: AbortSignal.timeout(TIMEOUT_MS),
          },
        );

        if (!response.ok) throw await failure(response, input.token);

        const text = await response.text();
        let parsed: EventsResponse;
        try {
          parsed = JSON.parse(text) as EventsResponse;
        } catch {
          // A 200 that is not JSON is a proxy page in front of Meta. A `SyntaxError` here
          // would reach the queue as an unexpected throw and be recorded as a bug in us.
          throw new CapiError(
            'Meta вернула ответ, который не удалось прочитать.',
            502,
            true,
            withoutSecret(text, input.token).slice(0, 500) || undefined,
          );
        }

        return {
          received: parsed.events_received ?? 0,
          fbtraceId: parsed.fbtrace_id ?? null,
        };
      });
    },
  };
}
