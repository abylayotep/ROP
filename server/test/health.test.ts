import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { createDb } from '../src/db/client.js';
import { testEnv } from './helpers/env.js';

describe('health', () => {
  it('answers without a session', async () => {
    // createDb does not connect until a query runs, and health never queries.
    const app = buildServer(testEnv(), createDb('postgres://unused'));

    const res = await app.inject({ method: 'GET', url: '/api/health' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});
