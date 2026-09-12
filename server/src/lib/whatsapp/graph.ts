import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';
import type { OutgoingFile } from './linked/client.js';

/**
 * Everything this product says to Meta.
 *
 * It is an interface first and an implementation second: the tests for sending, for media and
 * for connecting a number all inject a fake, so the suite never reaches the network and never
 * depends on a live number or a valid token.
 */

/** Pinned deliberately. Meta deprecates versions on a schedule; drifting silently is worse. */
const GRAPH_VERSION = 'v26.0';
/**
 * Exported so that the one other place talking to the Graph API — the Conversions API client
 * in `../capi/client.ts` — pins the same version. Two literals would drift, and the one that
 * drifted would be found by Meta turning it off.
 */
export const GRAPH_ROOT = `https://graph.facebook.com/${GRAPH_VERSION}`;

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
  /** Meta's `platform_type`, e.g. `CLOUD_API`. Null when Meta does not send it. */
  platformType: string | null;
  /** True for a number that also lives in the WhatsApp Business app on a phone. */
  isOnBizApp: boolean;
}

export type SmbSyncType = 'smb_app_state_sync' | 'history';

/**
 * A token and the moment it stops working.
 *
 * `expiresAt` is null when Meta names no lifetime, which is what a permanent system-user
 * token looks like. The distinction is the whole point of returning a pair rather than a
 * string: the configuration this product runs on today is built from Meta's «WhatsApp
 * Embedded Signup with 60-day token» template, so every token it issues has a deadline,
 * and a deadline nobody wrote down arrives as every number falling silent at once.
 */
export interface IssuedToken {
  token: string;
  expiresAt: Date | null;
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
  /** Uploads a local file before sending it by Meta media ID. */
  sendMedia?(
    phoneNumberId: string,
    token: string,
    to: string,
    file: OutgoingFile,
  ): Promise<{ messageId: string }>;
  /** The URL is short-lived, so callers must download immediately. */
  getMediaUrl(mediaId: string, token: string): Promise<MediaDescriptor>;
  downloadMedia(url: string, token: string): Promise<Buffer>;
  /**
   * Turns the code Embedded Signup hands the browser into a business token. Server-side
   * only: the app secret goes in the request, and the code dies after thirty seconds.
   */
  exchangeCode(code: string, appId: string, appSecret: string): Promise<IssuedToken>;
  /** The numbers of a WABA; needed when Embedded Signup reports only the WABA. */
  listPhoneNumbers(wabaId: string, token: string): Promise<PhoneNumber[]>;
  /** Asks Meta to stream the phone's contacts or history to the webhook. Once each. */
  requestSmbAppData(
    phoneNumberId: string,
    token: string,
    syncType: SmbSyncType,
  ): Promise<{ requestId: string }>;
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

async function call<T>(url: string, token: string, init: RequestInit = {}, timeoutMs = TIMEOUT_MS): Promise<T> {
  return within(timeoutMs, async () => {
    const response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
      // After `...init` on purpose: no caller passes a signal today, and if one starts, the
      // deadline is not the thing to lose silently.
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw await failure(response);
    return (await response.json()) as T;
  });
}

/**
 * Seconds of remaining life, as Meta reports them, turned into a moment.
 *
 * Meta writes `expires_in: 0` for a token that never expires, and omits the field
 * entirely on some responses. Both mean «no deadline»: read literally, the zero would
 * mean the token died on arrival and would lock the owner out of a number that works.
 */
function expiryFrom(expiresIn: number | undefined): Date | null {
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) return null;
  return new Date(Date.now() + expiresIn * 1000);
}

const PHONE_FIELDS = encodeURIComponent(
  'id,display_phone_number,verified_name,platform_type,is_on_biz_app',
);

interface RawPhone {
  id: string;
  display_phone_number: string;
  verified_name: string;
  platform_type?: string;
  is_on_biz_app?: boolean;
}

const toPhone = (raw: RawPhone): PhoneNumber => ({
  id: raw.id,
  displayPhoneNumber: raw.display_phone_number,
  verifiedName: raw.verified_name,
  platformType: raw.platform_type ?? null,
  isOnBizApp: raw.is_on_biz_app === true,
});

export function createGraphClient(): GraphClient {
  return {
    async getPhoneNumber(phoneNumberId, token) {
      return toPhone(
        await call<RawPhone>(`${GRAPH_ROOT}/${phoneNumberId}?fields=${PHONE_FIELDS}`, token),
      );
    },

    async exchangeCode(code, appId, appSecret) {
      const query = new URLSearchParams({ client_id: appId, client_secret: appSecret, code });
      // Not `call`: there is no bearer token yet, and `call` would send an empty one.
      return within(TIMEOUT_MS, async () => {
        const response = await fetch(`${GRAPH_ROOT}/oauth/access_token?${query}`, {
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!response.ok) throw await failure(response);
        const text = await response.text();
        try {
          const parsed = JSON.parse(text) as { access_token?: string; expires_in?: number };
          if (parsed.access_token) {
            return { token: parsed.access_token, expiresAt: expiryFrom(parsed.expires_in) };
          }
        } catch {
          // Not JSON. A gateway page answering 200 is not a token, and guessing at the
          // shape of the body would hand one downstream to be stored and encrypted.
        }
        throw new GraphError('Meta вернула ответ без токена', response.status);
      });
    },

    async listPhoneNumbers(wabaId, token) {
      const raw = await call<{ data: RawPhone[] }>(
        `${GRAPH_ROOT}/${wabaId}/phone_numbers?fields=${PHONE_FIELDS}`,
        token,
      );
      return (raw.data ?? []).map(toPhone);
    },

    async requestSmbAppData(phoneNumberId, token, syncType) {
      const raw = await call<{ request_id: string }>(
        `${GRAPH_ROOT}/${phoneNumberId}/smb_app_data`,
        token,
        {
          method: 'POST',
          body: JSON.stringify({ messaging_product: 'whatsapp', sync_type: syncType }),
        },
      );
      return { requestId: raw.request_id };
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

    async sendMedia(phoneNumberId, token, to, file) {
      const filename = file.filename || basename(file.path);
      const form = new FormData();
      form.set('messaging_product', 'whatsapp');
      form.set('type', file.mime);
      // A file-backed Blob avoids retaining large documents in process memory.
      form.set('file', await openAsBlob(file.path, { type: file.mime }), filename);
      const uploaded = await call<{ id?: string }>(
        `${GRAPH_ROOT}/${phoneNumberId}/media`, token,
        { method: 'POST', body: form }, MEDIA_TIMEOUT_MS,
      );
      if (!uploaded.id) throw new GraphError('Meta не вернула идентификатор файла.', 502);
      const kind = file.mime.startsWith('image/') ? 'image'
        : file.mime.startsWith('video/') ? 'video'
        : file.mime.startsWith('audio/') ? 'audio' : 'document';
      const media = {
        id: uploaded.id,
        ...(kind !== 'audio' && file.caption ? { caption: file.caption } : {}),
        ...(kind === 'document' ? { filename } : {}),
      };
      const sent = await call<{ messages?: { id?: string }[] }>(
        `${GRAPH_ROOT}/${phoneNumberId}/messages`, token,
        { method: 'POST', body: JSON.stringify({
          messaging_product: 'whatsapp', recipient_type: 'individual', to,
          type: kind, [kind]: media,
        }) },
      );
      const messageId = sent.messages?.[0]?.id;
      if (!messageId) throw new GraphError('Meta не вернула идентификатор сообщения.', 502);
      return { messageId };
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
