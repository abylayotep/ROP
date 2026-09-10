import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

// The inbound pass fires from a detached `setImmediate` after the response has already gone
// out (see `whatsapp-webhook.ts`), so it can still be running against the shared test database
// when the next test's `beforeEach` truncates and reseeds it — a cross-file race this file's
// missing `app.close()` left open. Ten other test files already close their server for exactly
// this reason.
afterEach(async () => {
  await app.close();
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
