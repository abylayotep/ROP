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
    <K extends keyof GraphClient>(method: K, fallback: (...args: unknown[]) => unknown): GraphClient[K] =>
      (async (...args: unknown[]) => {
        calls.push({ method, args });
        const chosen = (overrides[method] ?? fallback) as (...a: unknown[]) => unknown;
        return chosen(...args);
      }) as GraphClient[K];

  return {
    calls,
    getPhoneNumber: record('getPhoneNumber', async (id: unknown) => ({
      id,
      displayPhoneNumber: '+7 708 580 79 32',
      verifiedName: 'Aisham',
      platformType: 'CLOUD_API',
      isOnBizApp: true,
    })),
    subscribeApp: record('subscribeApp', async () => undefined),
    sendText: record('sendText', async () => ({ messageId: `wamid.${calls.length}` })),
    getMediaUrl: record('getMediaUrl', async () => ({
      url: 'https://lookaside.fb/media',
      mimeType: 'image/jpeg',
      fileSize: 3,
    })),
    downloadMedia: record('downloadMedia', async () => Buffer.from([1, 2, 3])),
    exchangeCode: record('exchangeCode', async () => 'EAAB-business-token'),
    listPhoneNumbers: record('listPhoneNumbers', async () => [
      {
        id: '136',
        displayPhoneNumber: '+7 708 580 79 32',
        verifiedName: 'Aisham',
        platformType: 'CLOUD_API',
        isOnBizApp: true,
      },
    ]),
    requestSmbAppData: record(
      'requestSmbAppData',
      async (_id: unknown, _t: unknown, syncType: unknown) => ({
        requestId: `req-${String(syncType)}`,
      }),
    ),
  };
}
