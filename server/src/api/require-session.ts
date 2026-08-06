import { eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { Db } from '../db/client.js';
import { users } from '../db/schema.js';
import { findValidSession, SESSION_COOKIE } from '../lib/session.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: typeof users.$inferSelect;
  }
}

/** Built once and shared by every module that registers protected routes. */
export function requireSession(db: Db): preHandlerHookHandler {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const id = req.cookies[SESSION_COOKIE];
    const session = id ? await findValidSession(db, id) : null;
    if (!session) return reply.code(401).send({ message: 'Нужно войти заново' });

    const [user] = await db.select().from(users).where(eq(users.id, session.userId));
    if (!user) return reply.code(401).send({ message: 'Нужно войти заново' });

    req.user = user;
  };
}
