import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { loadEnv } from '../src/env.js';

describe('health', () => {
  it('answers without a session', async () => {
    const app = buildServer(loadEnv({
      NODE_ENV: 'test', DATABASE_URL: 'postgres://x', SESSION_SECRET: 'x'.repeat(32),
    } as NodeJS.ProcessEnv));

    const res = await app.inject({ method: 'GET', url: '/api/health' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});
