import { loadEnv, type Env } from '../../src/env.js';

/**
 * A valid environment for tests.
 *
 * It exists so that adding a required variable is one edit rather than one per test file,
 * and so every suite agrees on the secret the webhook signature tests sign with.
 */
export function testEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): Env {
  return loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://x',
    SESSION_SECRET: 'x'.repeat(32),
    META_APP_SECRET: 'test-app-secret',
    META_WEBHOOK_VERIFY_TOKEN: 'test-verify-token',
    META_APP_ID: '1585667806534384',
    META_ES_CONFIG_ID: '1234567890',
    CREDENTIALS_KEY: Buffer.alloc(32, 7).toString('base64'),
    MEDIA_DIR: 'var/media-test',
    PUBLIC_URL: 'https://rakurs.test',
    ...overrides,
  } as NodeJS.ProcessEnv);
}
