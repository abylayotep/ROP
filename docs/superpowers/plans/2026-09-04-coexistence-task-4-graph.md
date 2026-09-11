# Task 4: Graph client — code exchange, numbers, sync requests

Part of [WhatsApp Coexistence](2026-09-04-whatsapp-coexistence.md). Depends on Task 2.

**Files:**
- Modify: `server/src/lib/whatsapp/graph.ts` (interface + `createGraphClient`)
- Modify: `server/test/helpers/fake-graph.ts`
- Test: `server/test/graph.test.ts`

**Interfaces:**
- Produces on `GraphClient`:
  - `exchangeCode(code: string, appId: string, appSecret: string): Promise<string>` — the business token.
  - `listPhoneNumbers(wabaId: string, token: string): Promise<PhoneNumber[]>`.
  - `requestSmbAppData(phoneNumberId: string, token: string, syncType: 'smb_app_state_sync' | 'history'): Promise<{ requestId: string }>`.
- `PhoneNumber` gains `platformType: string | null` and `isOnBizApp: boolean`.

- [ ] **Step 1: Failing tests**

Append to `server/test/graph.test.ts` inside `describe('graph client')`:

```ts
  it('exchanges an Embedded Signup code for a business token, server-side', async () => {
    answerWith({ access_token: 'EAAB-business', token_type: 'bearer' });

    const token = await client.exchangeCode('AQD-code', '1585667806534384', 'app-secret');

    expect(token).toBe('EAAB-business');
    expect(calls[0]!.url).toBe(
      'https://graph.facebook.com/v26.0/oauth/access_token?client_id=1585667806534384&client_secret=app-secret&code=AQD-code',
    );
    // No bearer header: there is no token yet, and the secret is in the query by Meta's design.
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('reads whether a number is on the phone app', async () => {
    answerWith({
      id: '136',
      display_phone_number: '+7 771 523 03 42',
      verified_name: 'Sealhouse',
      platform_type: 'CLOUD_API',
      is_on_biz_app: true,
    });

    const number = await client.getPhoneNumber('136', TOKEN);

    expect(number).toMatchObject({ platformType: 'CLOUD_API', isOnBizApp: true });
    expect(calls[0]!.url).toBe(
      'https://graph.facebook.com/v26.0/136?fields=id%2Cdisplay_phone_number%2Cverified_name%2Cplatform_type%2Cis_on_biz_app',
    );
  });

  it('lists the numbers of a WABA', async () => {
    answerWith({
      data: [
        { id: '136', display_phone_number: '+7 771 523 03 42', verified_name: 'Sealhouse', is_on_biz_app: true },
      ],
    });

    const numbers = await client.listPhoneNumbers('932', TOKEN);

    expect(numbers).toEqual([
      { id: '136', displayPhoneNumber: '+7 771 523 03 42', verifiedName: 'Sealhouse', platformType: null, isOnBizApp: true },
    ]);
    expect(calls[0]!.url).toBe(
      'https://graph.facebook.com/v26.0/932/phone_numbers?fields=id%2Cdisplay_phone_number%2Cverified_name%2Cplatform_type%2Cis_on_biz_app',
    );
  });

  it('requests a phone-app sync and returns the request id', async () => {
    answerWith({ messaging_product: 'whatsapp', request_id: 'req-1' });

    const result = await client.requestSmbAppData('136', TOKEN, 'history');

    expect(result).toEqual({ requestId: 'req-1' });
    expect(calls[0]!.url).toBe('https://graph.facebook.com/v26.0/136/smb_app_data');
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      messaging_product: 'whatsapp',
      sync_type: 'history',
    });
  });
```

Update the existing `reads a phone number` test in the same file: its expected URL now ends with `%2Cplatform_type%2Cis_on_biz_app`, and its `toEqual` becomes `toMatchObject` (the two new fields are `null`/`false` when Meta omits them).

- [ ] **Step 2: Run, expect failure**

`npm --prefix server test -- graph` → `exchangeCode is not a function` and the URL mismatch.

- [ ] **Step 3: Interface and implementation**

In `server/src/lib/whatsapp/graph.ts`:

```ts
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
```

Add to `GraphClient`:

```ts
  /**
   * Turns the code Embedded Signup hands the browser into a business token. Server-side
   * only: the app secret goes in the request, and the code dies after thirty seconds.
   */
  exchangeCode(code: string, appId: string, appSecret: string): Promise<string>;
  /** The numbers of a WABA; needed when Embedded Signup reports only the WABA. */
  listPhoneNumbers(wabaId: string, token: string): Promise<PhoneNumber[]>;
  /** Asks Meta to stream the phone's contacts or history to the webhook. Once each. */
  requestSmbAppData(
    phoneNumberId: string,
    token: string,
    syncType: SmbSyncType,
  ): Promise<{ requestId: string }>;
```

A shared field list and mapper above `createGraphClient`:

```ts
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
```

Replace `getPhoneNumber` and add the three methods inside `createGraphClient`:

```ts
    async getPhoneNumber(phoneNumberId, token) {
      return toPhone(await call<RawPhone>(`${GRAPH_ROOT}/${phoneNumberId}?fields=${PHONE_FIELDS}`, token));
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
          const parsed = JSON.parse(text) as { access_token?: string };
          if (parsed.access_token) return parsed.access_token;
        } catch {
          // Meta's docs show a bare token as the body; accept that shape too.
        }
        if (/^[A-Za-z0-9]+$/.test(text.trim())) return text.trim();
        throw new GraphError('Meta вернула ответ без токена', response.status);
      });
    },

    async listPhoneNumbers(wabaId, token) {
      const raw = await call<{ data: RawPhone[] }>(
        `${GRAPH_ROOT}/${wabaId}/phone_numbers?fields=${PHONE_FIELDS}`,
        token,
      );
      return raw.data.map(toPhone);
    },

    async requestSmbAppData(phoneNumberId, token, syncType) {
      const raw = await call<{ request_id: string }>(`${GRAPH_ROOT}/${phoneNumberId}/smb_app_data`, token, {
        method: 'POST',
        body: JSON.stringify({ messaging_product: 'whatsapp', sync_type: syncType }),
      });
      return { requestId: raw.request_id };
    },
```

- [ ] **Step 4: The fake**

In `server/test/helpers/fake-graph.ts`, extend the returned object:

```ts
    getPhoneNumber: record('getPhoneNumber', async (id: unknown) => ({
      id,
      displayPhoneNumber: '+7 708 580 79 32',
      verifiedName: 'Aisham',
      platformType: 'CLOUD_API',
      isOnBizApp: true,
    })),
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
    requestSmbAppData: record('requestSmbAppData', async (_id: unknown, _t: unknown, syncType: unknown) => ({
      requestId: `req-${String(syncType)}`,
    })),
```

- [ ] **Step 5: Run everything**

```bash
npm --prefix server test
npm --prefix server run typecheck
```

Expected: green. `whatsapp-numbers.test.ts` still passes: `getPhoneNumber` keeps `displayPhoneNumber`.

- [ ] **Step 6: Commit**

```bash
git add server/src/lib/whatsapp/graph.ts server/test/helpers/fake-graph.ts server/test/graph.test.ts
git commit -m "Teach the Graph client to exchange a signup code and request phone-app syncs"
```
