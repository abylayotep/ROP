const GRAPH_ROOT = 'https://graph.facebook.com/v23.0';
const TIMEOUT_MS = 20_000;

export interface MessagingAccount {
  instagramUserId: string;
  username: string | null;
  pageId: string;
  pageName: string;
  pageToken: string;
}

export interface InstagramMessagingClient {
  discover(userToken: string): Promise<MessagingAccount[]>;
  subscribe(pageId: string, pageToken: string, appId: string): Promise<void>;
  sendText(pageId: string, pageToken: string, recipientId: string, body: string): Promise<{ messageId: string }>;
}

export class InstagramMessagingError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
    this.name = 'InstagramMessagingError';
  }
}

async function call<T>(url: string, token: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init?.headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) {
    let detail = 'Meta отклонила запрос Instagram.';
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } };
      if (parsed.error?.message) detail = parsed.error.message;
    } catch { /* Keep the safe generic message for non-JSON gateway responses. */ }
    throw new InstagramMessagingError(detail, response.status);
  }
  try { return JSON.parse(text) as T; }
  catch { throw new InstagramMessagingError('Meta вернула некорректный ответ Instagram.'); }
}

export function createInstagramMessagingClient(): InstagramMessagingClient {
  return {
    async discover(userToken) {
      const fields = 'id,name,access_token,tasks,instagram_business_account{id,username}';
      const response = await call<{ data?: Array<{
        id?: string; name?: string; access_token?: string; tasks?: string[];
        instagram_business_account?: { id?: string; username?: string };
      }> }>(`${GRAPH_ROOT}/me/accounts?fields=${encodeURIComponent(fields)}&limit=100`, userToken);
      return (response.data ?? []).flatMap((page) => {
        const instagram = page.instagram_business_account;
        return page.id && page.access_token && instagram?.id && page.tasks?.includes('MESSAGING')
          ? [{ instagramUserId: instagram.id, username: instagram.username ?? null,
              pageId: page.id, pageName: page.name ?? page.id, pageToken: page.access_token }]
          : [];
      });
    },
    async subscribe(pageId, pageToken, appId) {
      const endpoint = `${GRAPH_ROOT}/${encodeURIComponent(pageId)}/subscribed_apps`;
      const response = await call<{ success?: boolean }>(
        `${endpoint}?subscribed_fields=messages`, pageToken, { method: 'POST' },
      );
      if (!response.success) throw new InstagramMessagingError('Meta не подтвердила подписку Instagram.');
      const verified = await call<{ data?: Array<{ id?: string; subscribed_fields?: string[] }> }>(`${endpoint}?fields=id,subscribed_fields`, pageToken);
      if (!(verified.data ?? []).some((entry) => entry.id === appId && entry.subscribed_fields?.includes('messages'))) {
        throw new InstagramMessagingError('Meta не показала активную подписку на сообщения Instagram.');
      }
    },
    async sendText(pageId, pageToken, recipientId, body) {
      const response = await call<{ message_id?: string }>(
        `${GRAPH_ROOT}/${encodeURIComponent(pageId)}/messages`, pageToken,
        { method: 'POST', body: JSON.stringify({ recipient: { id: recipientId }, messaging_type: 'RESPONSE', message: { text: body } }) },
      );
      if (!response.message_id) throw new InstagramMessagingError('Meta приняла запрос без ID сообщения.');
      return { messageId: response.message_id };
    },
  };
}
