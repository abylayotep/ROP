import { beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { users } from '../src/db/schema.js';
import { hashPassword } from '../src/lib/password.js';
import { SESSION_COOKIE } from '../src/lib/session.js';
import { withDb } from './helpers/db.js';
import { testEnv } from './helpers/env.js';

const env = testEnv();

let app: ReturnType<typeof buildServer>;

beforeEach(async () => {
  const db = await withDb();
  app = buildServer(env, db);
  await app.ready();
  await db.insert(users).values({
    email: 'owner@example.com',
    passwordHash: await hashPassword('right-password'),
    name: 'Владелец',
    initials: 'ВЛ',
  });
});

const login = (password: string, email = 'owner@example.com') =>
  app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });

describe('auth', () => {
  it('sets an httpOnly session cookie on success', async () => {
    const res = await login('right-password');

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      name: 'Владелец',
      initials: 'ВЛ',
      email: 'owner@example.com',
      accounts: [],
    });
    expect(res.cookies[0]).toMatchObject({ name: SESSION_COOKIE, httpOnly: true });
  });

  it('rejects a wrong password', async () => {
    const res = await login('wrong-password');

    expect(res.statusCode).toBe(401);
    expect(res.json().message).toBe('Неверная почта или пароль');
  });

  it('gives an unknown email the same answer as a wrong password', async () => {
    const res = await login('any', 'nobody@example.com');

    expect(res.statusCode).toBe(401);
    expect(res.json().message).toBe('Неверная почта или пароль');
  });

  it('matches the email case-insensitively and ignores surrounding space', async () => {
    expect((await login('right-password', '  OWNER@Example.com ')).statusCode).toBe(200);
  });

  it('rejects a body with no password', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: 'owner@example.com' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('answers /api/auth/me with the cookie from login', async () => {
    const cookie = (await login('right-password')).cookies[0]!;

    const res = await app.inject({
      method: 'GET', url: '/api/auth/me', cookies: { [cookie.name]: cookie.value },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: 'Владелец', initials: 'ВЛ' });
  });

  it('invalidates the session on logout', async () => {
    const cookie = (await login('right-password')).cookies[0]!;
    const jar = { [cookie.name]: cookie.value };

    await app.inject({ method: 'POST', url: '/api/auth/logout', cookies: jar });

    expect((await app.inject({ method: 'GET', url: '/api/auth/me', cookies: jar })).statusCode)
      .toBe(401);
  });
});
