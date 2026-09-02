import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import type { Me } from '@rakurs/contract';
import type { Db } from '../db/client.js';
import { users } from '../db/schema.js';
import type { Env } from '../env.js';
import { ApiError } from '../lib/errors.js';
import { buildMe } from '../lib/me.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { createSession, revokeSession, SESSION_COOKIE } from '../lib/session.js';

const credentials = z.object({ email: z.string().min(1), password: z.string().min(1) });

/**
 * Verified against when the email is unknown, so a missing user costs the same time as
 * a wrong password. Without it, response latency reveals which emails are registered.
 */
const ABSENT_USER_HASH = await hashPassword(randomUUID());

const cookieOptions = (env: Env, expires: Date) => ({
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: env.NODE_ENV === 'production', // local development is plain http
  path: '/',
  expires,
});

export function registerAuthRoutes(
  app: FastifyInstance,
  db: Db,
  env: Env,
  guard: preHandlerHookHandler,
): void {
  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const parsed = credentials.safeParse(req.body);
      if (!parsed.success) throw new ApiError(400, 'Укажите почту и пароль');

      const email = parsed.data.email.trim().toLowerCase();
      const [user] = await db.select().from(users).where(eq(users.email, email));

      const ok = await verifyPassword(
        user?.passwordHash ?? ABSENT_USER_HASH,
        parsed.data.password,
      );
      if (!user || !ok) throw new ApiError(401, 'Неверная почта или пароль');

      const session = await createSession(db, user.id);
      reply.setCookie(SESSION_COOKIE, session.id, cookieOptions(env, session.expiresAt));

      // Same shape as /api/auth/me, so the client stores one type either way.
      return buildMe(db, user);
    },
  );

  app.post('/api/auth/logout', async (req, reply) => {
    const id = req.cookies[SESSION_COOKIE];
    if (id) await revokeSession(db, id);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get(
    '/api/auth/me',
    { preHandler: guard },
    async (req): Promise<Me> => buildMe(db, req.user!),
  );
}
