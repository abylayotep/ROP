/**
 * Everything this product says to Meta.
 *
 * It is an interface first and an implementation second: the tests for sending, for media and
 * for connecting a number all inject a fake, so the suite never reaches the network and never
 * depends on a live number or a valid token.
 */

/** Pinned deliberately. Meta deprecates versions on a schedule; drifting silently is worse. */
const GRAPH_VERSION = 'v21.0';
const GRAPH_ROOT = `https://graph.facebook.com/${GRAPH_VERSION}`;

/**
 * Meta sits on the request path of an operator's action — sending a reply, or moving a lead
 * into a stage that answers for itself. `fetch` has no deadline of its own, so a Graph call
 * that never returns would hold that request open until the browser gave up, with nothing on
 * screen to explain the wait.
 */
const TIMEOUT_MS = 15_000;

/**
 * Downloading a file is bytes rather than a sentence of JSON, and it runs on Meta's webhook
 * delivery rather than under someone watching a screen. Meta allows documents up to 100 MB,
 * so the same fifteen seconds would drop files that were arriving perfectly well.
 */
const MEDIA_TIMEOUT_MS = 60_000;

export interface PhoneNumber {
  id: string;
  displayPhoneNumber: string;
  verifiedName: string;
}

export interface MediaDescriptor {
  url: string;
  mimeType: string;
  fileSize: number;
}

export interface GraphClient {
  /** Reads a number, which is also how a pasted token is proved to work. */
  getPhoneNumber(phoneNumberId: string, token: string): Promise<PhoneNumber>;
  /** Without this, Meta accepts the connection and delivers nothing. */
  subscribeApp(wabaId: string, token: string): Promise<void>;
  sendText(
    phoneNumberId: string,
    token: string,
    to: string,
    body: string,
  ): Promise<{ messageId: string }>;
  /** The URL is short-lived, so callers must download immediately. */
  getMediaUrl(mediaId: string, token: string): Promise<MediaDescriptor>;
  downloadMedia(url: string, token: string): Promise<Buffer>;
}

/** Carries Meta's own words, so a failure can be shown and searched for. */
export class GraphError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
  ) {
    super(message);
    this.name = 'GraphError';
  }
}

/** What stands where a secret was. One string, so every test can look for the same thing. */
export const REDACTED = '<токен скрыт>';

/**
 * An OpenRouter key by its shape rather than by its value.
 *
 * The exact match below is the whole defence only while the provider echoes the credential
 * back byte for byte. It does not always: a key can come back url-encoded inside a quoted
 * URL, or truncated to a prefix in a rate-limit message, and either survives a
 * `split`/`join` on the exact string while still being most of a working key. This catches
 * anything that opens like one — the `%` is there for the encoded case, and the length floor
 * keeps the literal word `sk-or-` in a sentence out of it.
 */
const KEY_SHAPE = /sk-or-[A-Za-z0-9%._~+-]{6,}/g;

/**
 * Meta echoes a rejected token back inside its own error text — «Malformed access token
 * <the token>». That text is shown to whoever pressed the button, so the secret has to be
 * taken out of it before it leaves this process. OpenRouter does the same with its key,
 * which is why this function is used by the model client and the turn as well.
 */
export function withoutSecret(message: string, secret: string): string {
  const exact = secret ? message.split(secret).join(REDACTED) : message;
  return exact.replace(KEY_SHAPE, REDACTED);
}

async function failure(response: Response): Promise<GraphError> {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string; code?: number } };
    if (parsed.error?.message) {
      return new GraphError(parsed.error.message, response.status, parsed.error.code);
    }
  } catch {
    // Not JSON. A gateway page or an empty body — say so rather than invent a reason.
  }
  return new GraphError(`HTTP ${response.status}`, response.status);
}

/**
 * Runs one exchange with Meta under a deadline, so that its expiry reads as Meta failing
 * rather than as a stray error.
 *
 * Node rejects an expired `AbortSignal.timeout` with a `TimeoutError` that is not a
 * `GraphError` and whose message is English. Every caller here branches on `GraphError` and
 * shows `message` to a Russian-speaking operator, so an unwrapped timeout would either be
 * rethrown as a 500 or rendered as «The operation was aborted due to timeout». 504, because
 * the request did leave this process — we simply never heard back.
 *
 * It wraps the whole exchange rather than the `fetch` alone: the signal stays live while the
 * body is read, and `fetch` resolves as soon as the headers arrive. A large download is
 * exactly where the deadline is most likely to pass, and it would pass on the body read.
 */
async function within<T>(timeoutMs: number, exchange: () => Promise<T>): Promise<T> {
  try {
    return await exchange();
  } catch (error) {
    if ((error as { name?: string } | null)?.name === 'TimeoutError') {
      throw new GraphError(`Meta не ответила за ${Math.round(timeoutMs / 1000)} с.`, 504);
    }
    throw error;
  }
}

async function call<T>(url: string, token: string, init: RequestInit = {}): Promise<T> {
  return within(TIMEOUT_MS, async () => {
    const response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
      // After `...init` on purpose: no caller passes a signal today, and if one starts, the
      // deadline is not the thing to lose silently.
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw await failure(response);
    return (await response.json()) as T;
  });
}

export function createGraphClient(): GraphClient {
  return {
    async getPhoneNumber(phoneNumberId, token) {
      const fields = encodeURIComponent('id,display_phone_number,verified_name');
      const raw = await call<{
        id: string;
        display_phone_number: string;
        verified_name: string;
      }>(`${GRAPH_ROOT}/${phoneNumberId}?fields=${fields}`, token);

      return {
        id: raw.id,
        displayPhoneNumber: raw.display_phone_number,
        verifiedName: raw.verified_name,
      };
    },

    async subscribeApp(wabaId, token) {
      await call(`${GRAPH_ROOT}/${wabaId}/subscribed_apps`, token, { method: 'POST' });
    },

    async sendText(phoneNumberId, token, to, body) {
      const sent = await call<{ messages: { id: string }[] }>(
        `${GRAPH_ROOT}/${phoneNumberId}/messages`,
        token,
        {
          method: 'POST',
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to,
            type: 'text',
            // Link previews are off: a preview of a competitor's page under our own
            // message is not something an operator asked for.
            text: { preview_url: false, body },
          }),
        },
      );
      return { messageId: sent.messages[0]!.id };
    },

    async getMediaUrl(mediaId, token) {
      const raw = await call<{ url: string; mime_type: string; file_size: number }>(
        `${GRAPH_ROOT}/${mediaId}`,
        token,
      );
      return { url: raw.url, mimeType: raw.mime_type, fileSize: raw.file_size };
    },

    async downloadMedia(url, token) {
      // Not `call`: the answer is bytes, and the host is lookaside.fb, not the Graph root.
      return within(MEDIA_TIMEOUT_MS, async () => {
        const response = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(MEDIA_TIMEOUT_MS),
        });
        if (!response.ok) throw await failure(response);
        return Buffer.from(await response.arrayBuffer());
      });
    },
  };
}
