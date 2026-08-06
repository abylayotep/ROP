import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { requireSession } from '../src/api/require-session.js';
import { users } from '../src/db/schema.js';
import { createSession, SESSION_COOKIE, SESSION_TTL_MS } from '../src/lib/session.js';
import { withDb } from './helpers/db.js';

/** The guard mounted on a throwaway route, so it is tested before any real route needs it. */
async function appWithGuard() {
  const db = await withDb();
  const app = Fastify();
  await app.register(cookie);
  app.get('/protected', { preHandler: requireSession(db) }, async (req) => ({
    initials: req.user!.initials,
  }));
  await app.ready();
  return { app, db };
}

describe('requireSession', () => {
  it('refuses a request with no cookie', async () => {
    const { app } = await appWithGuard();

    expect((await app.inject({ method: 'GET', url: '/protected' })).statusCode).toBe(401);
  });

  it('refuses a junk cookie instead of raising', async () => {
    const { app } = await appWithGuard();

    const res = await app.inject({
      method: 'GET', url: '/protected', cookies: { [SESSION_COOKIE]: 'not-a-uuid' },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().message).toBe('Нужно войти заново');
  });

  it('admits a valid session and exposes the user', async () => {
    const { app, db } = await appWithGuard();
    const [user] = await db.insert(users).values({
      email: 'g@example.com', passwordHash: 'x', name: 'G', initials: 'ГГ',
    }).returning();
    const session = await createSession(db, user!.id);

    const res = await app.inject({
      method: 'GET', url: '/protected', cookies: { [SESSION_COOKIE]: session.id },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ initials: 'ГГ' });
  });

  it('refuses a session that has expired', async () => {
    const { app, db } = await appWithGuard();
    const [user] = await db.insert(users).values({
      email: 'e@example.com', passwordHash: 'x', name: 'E', initials: 'ЕЕ',
    }).returning();
    const session = await createSession(db, user!.id, new Date(Date.now() - SESSION_TTL_MS - 1000));

    const res = await app.inject({
      method: 'GET', url: '/protected', cookies: { [SESSION_COOKIE]: session.id },
    });

    expect(res.statusCode).toBe(401);
  });
});
