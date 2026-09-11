/**
 * Что кабинет спрашивает у Instagram: профиль продавца и подписи под его постами.
 *
 * Instagram serves none of this to a server that asks for the page: the public profile
 * answers a login wall, and a scraper would be broken by the next change to that wall.
 * The official road is the Graph API, and it is narrow on purpose — an Instagram account
 * is reachable only when it is a Business or Creator account attached to a Facebook Page
 * the owner administers. Everything below assumes that and says so plainly when it is not
 * true, because «ничего не нашлось» is the one answer an owner cannot act on.
 *
 * Captions only. The photos stay in Instagram: the knowledge base answers customers in
 * words, and a shop's own words about its goods are what the agent is missing.
 */

const GRAPH_ROOT = 'https://graph.facebook.com/v23.0';

/** Beyond this the import stops asking for more pages. */
const MAX_POSTS = 200;
const PAGE_SIZE = 50;
const TIMEOUT_MS = 20_000;

export interface InstagramAccount {
  id: string;
  username: string;
  /** Шапка профиля: чем магазин представляется. Пустая у многих аккаунтов. */
  biography: string | null;
  website: string | null;
  /** The Facebook Page the account hangs off, for the error messages and the source title. */
  pageName: string | null;
}

export interface InstagramPost {
  id: string;
  caption: string | null;
  permalink: string;
  /** ISO 8601, as Meta returns it. */
  timestamp: string;
  mediaType: string;
}

export interface InstagramClient {
  /** The one Instagram account this token can read, or a refusal that says what is missing. */
  account(token: string): Promise<InstagramAccount>;
  posts(token: string, accountId: string): Promise<InstagramPost[]>;
}

/** Carries Meta's own words: an owner searching for them finds Meta's documentation. */
export class InstagramError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstagramError';
  }
}

interface PagesResponse {
  data?: {
    name?: string;
    instagram_business_account?: {
      id?: string;
      username?: string;
      biography?: string;
      website?: string;
    };
  }[];
}

interface MediaResponse {
  data?: {
    id?: string;
    caption?: string;
    permalink?: string;
    timestamp?: string;
    media_type?: string;
  }[];
  paging?: { next?: string };
}

async function get<T>(url: string, token: string): Promise<T> {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await response.text();

  if (!response.ok) {
    let detail = text;
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } };
      if (parsed.error?.message) detail = parsed.error.message;
    } catch {
      // Meta answered something that is not JSON. The body is the best detail there is.
    }
    throw new InstagramError(detail);
  }

  return JSON.parse(text) as T;
}

export function createInstagramClient(): InstagramClient {
  return {
    async account(token) {
      const query = new URLSearchParams({
        fields: 'name,instagram_business_account{id,username,biography,website}',
        limit: '50',
      });
      const pages = await get<PagesResponse>(`${GRAPH_ROOT}/me/accounts?${query}`, token);

      const page = (pages.data ?? []).find((entry) => entry.instagram_business_account?.id);
      const account = page?.instagram_business_account;
      if (!account?.id || !account.username) {
        // Two different setups end here and both are the owner's to fix in Meta, so the
        // sentence names the requirement rather than the API call that came back empty.
        throw new InstagramError(
          'К этому аккаунту Meta не привязан Instagram. Нужен профиль Instagram типа ' +
            '«Бизнес» или «Автор», привязанный к странице Facebook, которой вы управляете.',
        );
      }

      return {
        id: account.id,
        username: account.username,
        biography: account.biography?.trim() || null,
        website: account.website?.trim() || null,
        pageName: page?.name ?? null,
      };
    },

    async posts(token, accountId) {
      const query = new URLSearchParams({
        fields: 'caption,permalink,timestamp,media_type',
        limit: String(PAGE_SIZE),
      });

      const collected: InstagramPost[] = [];
      let url: string | undefined = `${GRAPH_ROOT}/${accountId}/media?${query}`;

      while (url && collected.length < MAX_POSTS) {
        const page: MediaResponse = await get<MediaResponse>(url, token);
        for (const entry of page.data ?? []) {
          if (!entry.id || !entry.permalink || !entry.timestamp) continue;
          collected.push({
            id: entry.id,
            caption: entry.caption?.trim() || null,
            permalink: entry.permalink,
            timestamp: entry.timestamp,
            mediaType: entry.media_type ?? 'UNKNOWN',
          });
          if (collected.length >= MAX_POSTS) break;
        }
        // Meta's own cursor, used as given: rebuilding it from `after` is how an import
        // quietly starts from the first page again and duplicates everything.
        url = page.paging?.next;
      }

      return collected;
    },
  };
}
