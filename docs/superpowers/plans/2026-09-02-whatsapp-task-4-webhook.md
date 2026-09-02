# Task 4: The webhook — handshake, signature, storage

Part of [WhatsApp Cloud API](2026-09-02-whatsapp-cloud-api.md).

The only unauthenticated write in the product, and therefore the only route that decides who is
calling by cryptography rather than by session. This task takes deliveries and stores them; task
5 turns a stored delivery into messages.

**Files:**
- Create: `server/src/lib/whatsapp/signature.ts`
- Create: `server/src/api/whatsapp-webhook.ts`
- Modify: `server/src/api/server.ts`
- Test: `server/test/whatsapp-webhook.test.ts`

**Interfaces:**
- Consumes: `whatsappEvents` from task 2; `Env` from task 1.
- Produces: `verifySignature(raw: Buffer, header: string | undefined, secret: string): boolean`
  from `server/src/lib/whatsapp/signature.ts`, and
  `registerWhatsappWebhook(app: FastifyInstance, db: Db, env: Env): void`.

---

- [ ] **Step 1: Write the failing test**

Create `server/test/whatsapp-webhook.test.ts`:

```ts
import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { whatsappEvents } from '../src/db/schema.js';
import { withDb } from './helpers/db.js';
import { testEnv } from './helpers/env.js';

const env = testEnv();

let app: FastifyInstance;
let db: Awaited<ReturnType<typeof withDb>>;

beforeEach(async () => {
  db = await withDb();
  app = buildServer(env, db);
  await app.ready();
});

const payload = {
  object: 'whatsapp_business_account',
  entry: [{ id: '932', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp' } }] }],
};

const sign = (raw: string) =>
  `sha256=${createHmac('sha256', env.META_APP_SECRET).update(raw).digest('hex')}`;

const deliver = (body: unknown, signature?: string) => {
  const raw = JSON.stringify(body);
  return app.inject({
    method: 'POST',
    url: '/api/whatsapp/webhook',
    headers: {
      'content-type': 'application/json',
      ...(signature === undefined ? { 'x-hub-signature-256': sign(raw) } : { 'x-hub-signature-256': signature }),
    },
    payload: raw,
  });
};

describe('webhook handshake', () => {
  it('answers Meta with the challenge when the token matches', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/whatsapp/webhook',
      query: {
        'hub.mode': 'subscribe',
        'hub.verify_token': env.META_WEBHOOK_VERIFY_TOKEN,
        'hub.challenge': '1158201444',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('1158201444');
  });

  it('refuses a wrong token without saying anything', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/whatsapp/webhook',
      query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'guess', 'hub.challenge': '1' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.body).toBe('');
  });

  it('refuses a mode it does not know', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/whatsapp/webhook',
      query: {
        'hub.mode': 'unsubscribe',
        'hub.verify_token': env.META_WEBHOOK_VERIFY_TOKEN,
        'hub.challenge': '1',
      },
    });

    expect(res.statusCode).toBe(403);
  });
});

describe('webhook deliveries', () => {
  it('stores a signed delivery and answers 200', async () => {
    const res = await deliver(payload);

    expect(res.statusCode).toBe(200);
    const [stored] = await db.select().from(whatsappEvents);
    expect(stored!.payload).toEqual(payload);
    expect(stored!.receivedAt).toBeInstanceOf(Date);
  });

  it('refuses a forged signature and stores nothing', async () => {
    const res = await deliver(payload, 'sha256=deadbeef');

    expect(res.statusCode).toBe(401);
    expect(await db.select().from(whatsappEvents)).toEqual([]);
  });

  it('refuses a delivery with no signature at all', async () => {
    const raw = JSON.stringify(payload);
    const res = await app.inject({
      method: 'POST',
      url: '/api/whatsapp/webhook',
      headers: { 'content-type': 'application/json' },
      payload: raw,
    });

    expect(res.statusCode).toBe(401);
  });

  it('refuses a body that was edited after signing', async () => {
    const signature = sign(JSON.stringify(payload));
    const res = await app.inject({
      method: 'POST',
      url: '/api/whatsapp/webhook',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
      payload: JSON.stringify({ ...payload, object: 'tampered' }),
    });

    expect(res.statusCode).toBe(401);
  });

  it('answers 400 when the signature is valid but the body is not JSON', async () => {
    const raw = 'not json at all';
    const res = await app.inject({
      method: 'POST',
      url: '/api/whatsapp/webhook',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(raw) },
      payload: raw,
    });

    expect(res.statusCode).toBe(400);
    expect(await db.select().from(whatsappEvents)).toEqual([]);
  });

  it('leaves the rest of the API parsing JSON as before', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'nobody@example.com', password: 'x' },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().message).toBe('Неверная почта или пароль');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm --prefix server test -- whatsapp-webhook
```

Expected: FAIL — the route does not exist, so the handshake answers 404.

- [ ] **Step 3: Write the signature check**

Create `server/src/lib/whatsapp/signature.ts`:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Meta signs every delivery with the application secret.
 *
 * The hash must be taken over the exact bytes that arrived: parsing and re-serialising JSON
 * changes key order and whitespace, and the signature no longer matches.
 *
 * The comparison is constant-time. A byte-by-byte comparison that returns early leaks, through
 * timing, how much of a guessed signature was right, which is enough to forge one.
 */
export function verifySignature(
  raw: Buffer,
  header: string | undefined,
  secret: string,
): boolean {
  if (!header?.startsWith('sha256=')) return false;

  const expected = Buffer.from(
    `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`,
    'utf8',
  );
  const given = Buffer.from(header, 'utf8');

  // timingSafeEqual throws on a length mismatch, so the lengths are compared first — a
  // wrong length is not a secret worth protecting.
  return expected.length === given.length && timingSafeEqual(expected, given);
}
```

- [ ] **Step 4: Write the routes**

Create `server/src/api/whatsapp-webhook.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/client.js';
import { whatsappEvents } from '../db/schema.js';
import type { Env } from '../env.js';
import { verifySignature } from '../lib/whatsapp/signature.js';

/**
 * Meta's two webhook routes.
 *
 * They live in their own Fastify scope because this is the one place in the product that needs
 * the raw request body: the signature is over the bytes Meta sent, and Fastify's default JSON
 * parser hands back an object those bytes cannot be recovered from. A content-type parser
 * registered inside a scope applies only there, so the rest of the API keeps receiving parsed
 * JSON exactly as before.
 *
 * There is no session guard here by design — Meta has no session. The signature is the check.
 */
export function registerWhatsappWebhook(app: FastifyInstance, db: Db, env: Env): void {
  app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (_req, body, done) => done(null, body),
    );

    /**
     * The handshake. Meta calls this once when the webhook address is saved and expects the
     * challenge echoed as plain text — a JSON body, even one containing the right number,
     * fails verification.
     */
    scope.get('/api/whatsapp/webhook', async (req, reply) => {
      const query = req.query as Record<string, string | undefined>;

      if (
        query['hub.mode'] === 'subscribe' &&
        query['hub.verify_token'] === env.META_WEBHOOK_VERIFY_TOKEN
      ) {
        return reply.type('text/plain').send(query['hub.challenge'] ?? '');
      }
      return reply.code(403).send();
    });

    scope.post('/api/whatsapp/webhook', async (req, reply) => {
      const raw = req.body as Buffer;

      if (!verifySignature(raw, req.headers['x-hub-signature-256'] as string | undefined, env.META_APP_SECRET)) {
        // Deliberately terse: an attacker probing the endpoint learns nothing from it.
        return reply.code(401).send();
      }

      let payload: unknown;
      try {
        payload = JSON.parse(raw.toString('utf8'));
      } catch {
        // Signed by us, yet not JSON. Retrying will not help, so do not ask Meta to.
        return reply.code(400).send();
      }

      await db.insert(whatsappEvents).values({ payload });

      // Answer before parsing. Meta retries only on a non-200, so a parser that throws
      // after this point costs nothing: the row above is the message, and task 5's
      // processing runs from it.
      return reply.code(200).send();
    });
  });
}
```

- [ ] **Step 5: Register it**

In `server/src/api/server.ts`, import `registerWhatsappWebhook` and call it beside the others:

```ts
  registerWhatsappWebhook(app, db, env);
```

Put it after `registerAgentRoutes`, and add a one-line comment saying it takes no guard because
Meta has no session.

- [ ] **Step 6: Run the tests**

```bash
npm --prefix server test
npm --prefix server run typecheck
```

Expected: PASS, nine new cases. The last one matters most: it proves the scoped parser did not
change how the rest of the API reads JSON.

- [ ] **Step 7: Commit**

```bash
git add -A server
git commit -m "Receive and store signed WhatsApp webhook deliveries"
```
