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

/**
 * Meta echoes a rejected token back inside its own error text — «Malformed access token
 * <the token>». That text is shown to whoever pressed the button, so the secret has to be
 * taken out of it before it leaves this process.
 */
export function withoutSecret(message: string, secret: string): string {
  return secret ? message.split(secret).join('<токен скрыт>') : message;
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

async function call<T>(url: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  if (!response.ok) throw await failure(response);
  return (await response.json()) as T;
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
      const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw await failure(response);
      return Buffer.from(await response.arrayBuffer());
    },
  };
}
