import { beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { users } from '../src/db/schema.js';
import { loadEnv } from '../src/env.js';
import { hashPassword } from '../src/lib/password.js';
import { withDb } from './helpers/db.js';

const env = loadEnv({
  NODE_ENV: 'test', DATABASE_URL: 'postgres://x', SESSION_SECRET: 'x'.repeat(32),
} as NodeJS.ProcessEnv);

let app: ReturnType<typeof buildServer>;
let jar: Record<string, string>;

beforeEach(async () => {
  const db = await withDb();
  app = buildServer(env, db);
  await app.ready();
  await db.insert(users).values({
    email: 'owner@example.com', passwordHash: await hashPassword('pw'),
    name: 'Владелец', initials: 'ВЛ',
  });
  const res = await app.inject({
    method: 'POST', url: '/api/auth/login',
    payload: { email: 'owner@example.com', password: 'pw' },
  });
  const cookie = res.cookies[0]!;
  jar = { [cookie.name]: cookie.value };
});

describe('profile and settings routes', () => {
  it('refuses the profile without a session', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/profile' })).statusCode).toBe(401);
  });

  it('returns usdRate as a number, not the string Postgres gives back', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/profile', cookies: jar });

    expect(res.statusCode).toBe(200);
    expect(typeof res.json().usdRate).toBe('number');
    expect(res.json().user.initials).toBe('ВЛ');
  });

  it('refuses settings without a session', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/settings' })).statusCode).toBe(401);
  });

  it('persists a settings patch', async () => {
    await app.inject({
      method: 'PATCH', url: '/api/settings', cookies: jar,
      payload: { selectedAccounts: ['act_1', 'act_2'] },
    });

    const res = await app.inject({ method: 'GET', url: '/api/settings', cookies: jar });

    expect(res.json().selectedAccounts).toEqual(['act_1', 'act_2']);
  });

  it('rejects a malformed patch', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/api/settings', cookies: jar,
      payload: { selectedAccounts: 'nope' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('Не удалось разобрать настройки');
  });
});
