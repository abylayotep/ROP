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
  discover(userToken: string, onDiagnostic?: (diagnostic: MessagingDiscoveryDiagnostic) => void,
    grantedPageIds?: string[]): Promise<MessagingAccount[]>;
  subscribe(pageId: string, pageToken: string, appId: string): Promise<void>;
  sendText(pageId: string, pageToken: string, recipientId: string, body: string): Promise<{ messageId: string }>;
}

export interface MessagingDiscoveryDiagnostic {
  pageCount: number;
  pagesWithToken: number;
  pagesWithInstagram: number;
  pagesWithMessagingTask: number;
  taskNames: string[];
  fallbackCount: number;
}

export class InstagramMessagingError extends Error {
  constructor(message: string, readonly status = 502, readonly code?: number, readonly subcode?: number) {
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
    let code: number | undefined;
    let subcode: number | undefined;
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string; code?: number; error_subcode?: number } };
      if (parsed.error?.message) detail = parsed.error.message;
      code = parsed.error?.code;
      subcode = parsed.error?.error_subcode;
    } catch { /* Keep the safe generic message for non-JSON gateway responses. */ }
    throw new InstagramMessagingError(detail, response.status, code, subcode);
  }
  try { return JSON.parse(text) as T; }
  catch { throw new InstagramMessagingError('Meta вернула некорректный ответ Instagram.'); }
}

export function createInstagramMessagingClient(): InstagramMessagingClient {
  return {
    async discover(userToken, onDiagnostic, grantedPageIds) {
      const fields = 'id,name,access_token,tasks,instagram_business_account{id,username}';
      const response = await call<{ data?: Array<{
        id?: string; name?: string; access_token?: string; tasks?: string[];
        instagram_business_account?: { id?: string; username?: string };
      }> }>(`${GRAPH_ROOT}/me/accounts?fields=${encodeURIComponent(fields)}&limit=100`, userToken);
      const pages = response.data ?? [];
      const approved = [...new Set((grantedPageIds ?? []).filter((id) => /^\d+$/.test(id)))];
      if (approved.length > 20) throw new InstagramMessagingError('Meta выдала слишком много страниц для подключения.', 400);
      const approvedSet = new Set(approved);
      const standard = pages.flatMap((page) => {
        const instagram = page.instagram_business_account;
        return page.id && page.access_token && instagram?.id && page.tasks?.includes('MESSAGING')
          && (grantedPageIds === undefined || approvedSet.has(page.id))
          ? [{ instagramUserId: instagram.id, username: instagram.username ?? null,
              pageId: page.id, pageName: page.name ?? page.id, pageToken: page.access_token }]
          : [];
      });
      const missing = approved.filter((id) => !standard.some((entry) => entry.pageId === id));
      const direct = await Promise.all(missing.map(async (id): Promise<MessagingAccount | null> => {
        let page: { id?: string; name?: string; access_token?: string;
          instagram_business_account?: { id?: string; username?: string } };
        try {
          page = await call<typeof page>(
            `${GRAPH_ROOT}/${id}?fields=${encodeURIComponent('id,name,access_token,instagram_business_account{id,username}')}`,
            userToken);
        } catch (error) {
          if (error instanceof InstagramMessagingError && [400, 404].includes(error.status) && error.code === 100) return null;
          throw error;
        }
        const instagram = page.instagram_business_account;
        return page.id === id && page.access_token && instagram?.id
          ? { instagramUserId: instagram.id, username: instagram.username ?? null,
              pageId: id, pageName: page.name ?? id, pageToken: page.access_token }
          : null;
      }));
      const fallback = direct.filter((entry): entry is MessagingAccount => entry !== null);
      onDiagnostic?.({
        pageCount: pages.length,
        pagesWithToken: pages.filter((page) => Boolean(page.access_token)).length,
        pagesWithInstagram: pages.filter((page) => Boolean(page.instagram_business_account?.id)).length,
        pagesWithMessagingTask: pages.filter((page) => page.tasks?.includes('MESSAGING')).length,
        taskNames: [...new Set(pages.flatMap((page) => page.tasks ?? []))].sort(),
        fallbackCount: fallback.length,
      });
      return [...standard, ...fallback];
    },
    /**
     * Installs the app on the Page. Instagram messages are delivered by the app-level
     * `instagram` webhook, which Meta only routes for Pages the app is installed on; any Page
     * field installs it. `feed` is used because `messages` is a Messenger field that demands
     * pages_messaging, which Meta refuses with (#200) for a Direct-only login.
     */
    async subscribe(pageId, pageToken, appId) {
      const endpoint = `${GRAPH_ROOT}/${encodeURIComponent(pageId)}/subscribed_apps`;
      const response = await call<{ success?: boolean }>(
        `${endpoint}?subscribed_fields=feed`, pageToken, { method: 'POST' },
      );
      if (!response.success) throw new InstagramMessagingError('Meta не подтвердила подписку Instagram.');
      const verified = await call<{ data?: Array<{ id?: string; subscribed_fields?: string[] }> }>(`${endpoint}?fields=id,subscribed_fields`, pageToken);
      if (!(verified.data ?? []).some((entry) => entry.id === appId && entry.subscribed_fields?.includes('feed'))) {
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
