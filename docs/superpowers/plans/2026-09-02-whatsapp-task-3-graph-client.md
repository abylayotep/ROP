# Task 3: The Graph client

Part of [WhatsApp Cloud API](2026-09-02-whatsapp-cloud-api.md).

Everything this product says to Meta goes through one small object. It exists as an interface
so that tasks 7, 8 and 9 can be tested without the network, and so the Graph version and the
error shape live in one file rather than in five call sites.

**Files:**
- Create: `server/src/lib/whatsapp/graph.ts`
- Create: `server/test/helpers/fake-graph.ts`
- Test: `server/test/graph.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces from `server/src/lib/whatsapp/graph.ts`:
  `GraphClient` with `getPhoneNumber`, `subscribeApp`, `sendText`, `getMediaUrl`,
  `downloadMedia`; `createGraphClient(): GraphClient`; and `GraphError`.
  From `server/test/helpers/fake-graph.ts`: `fakeGraph(overrides?)`, which records calls.

---

- [ ] **Step 1: Write the failing test**

Create `server/test/graph.test.ts`. It drives the real client with a stubbed `fetch`, so it
proves the URLs, headers and bodies without a network:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGraphClient, GraphError } from '../src/lib/whatsapp/graph.js';

const client = createGraphClient();
const TOKEN = 'EAAG-token';

let calls: { url: string; init: RequestInit }[];

function answerWith(body: unknown, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('graph client', () => {
  it('reads a phone number and returns what the cabinet shows', async () => {
    answerWith({ id: '136', display_phone_number: '+7 708 580 79 32', verified_name: 'Aisham' });

    const number = await client.getPhoneNumber('136', TOKEN);

    expect(number).toEqual({
      id: '136',
      displayPhoneNumber: '+7 708 580 79 32',
      verifiedName: 'Aisham',
    });
    expect(calls[0]!.url).toBe(
      'https://graph.facebook.com/v21.0/136?fields=id%2Cdisplay_phone_number%2Cverified_name',
    );
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${TOKEN}`,
    );
  });

  it('subscribes the application to a WABA', async () => {
    answerWith({ success: true });

    await client.subscribeApp('932', TOKEN);

    expect(calls[0]!.url).toBe('https://graph.facebook.com/v21.0/932/subscribed_apps');
    expect(calls[0]!.init.method).toBe('POST');
  });

  it('sends text and returns the id WhatsApp assigned', async () => {
    answerWith({ messages: [{ id: 'wamid.OUT' }] });

    const sent = await client.sendText('136', TOKEN, '77771234567', 'Здравствуйте!');

    expect(sent).toEqual({ messageId: 'wamid.OUT' });
    expect(calls[0]!.url).toBe('https://graph.facebook.com/v21.0/136/messages');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '77771234567',
      type: 'text',
      text: { preview_url: false, body: 'Здравствуйте!' },
    });
  });

  it('reads a media descriptor', async () => {
    answerWith({ url: 'https://lookaside.fb/x', mime_type: 'image/jpeg', file_size: 1024 });

    expect(await client.getMediaUrl('media-1', TOKEN)).toEqual({
      url: 'https://lookaside.fb/x',
      mimeType: 'image/jpeg',
      fileSize: 1024,
    });
  });

  it('downloads a file with the token attached', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init: RequestInit = {}) => {
        calls.push({ url: String(url), init });
        return new Response(Buffer.from([1, 2, 3]), { status: 200 });
      }),
    );

    const bytes = await client.downloadMedia('https://lookaside.fb/x', TOKEN);

    expect([...bytes]).toEqual([1, 2, 3]);
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${TOKEN}`,
    );
  });

  it('turns a Meta error into one we can show and log', async () => {
    answerWith(
      { error: { message: 'Invalid OAuth access token.', code: 190, type: 'OAuthException' } },
      401,
    );

    await expect(client.getPhoneNumber('136', 'stale', )).rejects.toThrow(GraphError);
    await expect(client.getPhoneNumber('136', 'stale')).rejects.toThrow(
      'Invalid OAuth access token.',
    );
  });

  it('reports a non-JSON failure without pretending to know why', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>502</html>', { status: 502 })),
    );

    await expect(client.sendText('136', TOKEN, '777', 'hi')).rejects.toThrow('HTTP 502');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm --prefix server test -- graph
```

Expected: FAIL — cannot resolve `../src/lib/whatsapp/graph.js`.

- [ ] **Step 3: Write the client**

Create `server/src/lib/whatsapp/graph.ts`:

```ts
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
```

- [ ] **Step 4: Run it and watch it pass**

```bash
npm --prefix server test -- graph
```

Expected: PASS, seven cases.

- [ ] **Step 5: Write the fake the later tasks use**

Create `server/test/helpers/fake-graph.ts`:

```ts
import type { GraphClient } from '../../src/lib/whatsapp/graph.js';

export interface FakeGraph extends GraphClient {
  /** Every call in order, so a test can assert what was said to Meta and with which token. */
  calls: { method: keyof GraphClient; args: unknown[] }[];
}

/**
 * A Graph client that answers plausibly and records what it was asked.
 *
 * Overrides replace one method: pass `{ sendText: async () => { throw new GraphError(...) } }`
 * to test a failure without touching the others.
 */
export function fakeGraph(overrides: Partial<GraphClient> = {}): FakeGraph {
  const calls: FakeGraph['calls'] = [];
  const record =
    <K extends keyof GraphClient>(method: K, fallback: GraphClient[K]): GraphClient[K] =>
      (async (...args: unknown[]) => {
        calls.push({ method, args });
        const chosen = (overrides[method] ?? fallback) as (...a: unknown[]) => unknown;
        return chosen(...args);
      }) as GraphClient[K];

  return {
    calls,
    getPhoneNumber: record('getPhoneNumber', async (id: string) => ({
      id,
      displayPhoneNumber: '+7 708 580 79 32',
      verifiedName: 'Aisham',
    })),
    subscribeApp: record('subscribeApp', async () => undefined),
    sendText: record('sendText', async () => ({ messageId: `wamid.${calls.length}` })),
    getMediaUrl: record('getMediaUrl', async () => ({
      url: 'https://lookaside.fb/media',
      mimeType: 'image/jpeg',
      fileSize: 3,
    })),
    downloadMedia: record('downloadMedia', async () => Buffer.from([1, 2, 3])),
  };
}
```

The `record` helper is typed loosely on purpose; if the compiler rejects a cast here, widen the
fallback's parameters rather than changing `GraphClient`, which is the contract the production
code depends on.

- [ ] **Step 6: Run everything**

```bash
npm --prefix server test
npm --prefix server run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A server
git commit -m "Add the Meta Graph client and a fake for the tests"
```
