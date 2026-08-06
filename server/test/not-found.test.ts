import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { createDb } from '../src/db/client.js';
import { loadEnv } from '../src/env.js';

const env = loadEnv({
  NODE_ENV: 'test', DATABASE_URL: 'postgres://x', SESSION_SECRET: 'x'.repeat(32),
} as NodeJS.ProcessEnv);

describe('unknown routes', () => {
  it('answers in the product language, not Fastify default English', async () => {
    const app = buildServer(env, createDb('postgres://unused'));
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/overview?days=30' });

    expect(res.statusCode).toBe(404);
    // The frontend renders `message` verbatim, so this string reaches the user.
    expect(res.json().message).toBe('Раздел ещё не подключён');
    expect(res.json().message).not.toMatch(/Route|not found/);
  });
});
