import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Db } from '../db/client.js';
import type { Env } from '../env.js';
import { ApiError } from '../lib/errors.js';
import { registerAuthRoutes } from './auth.js';
import { requireSession } from './require-session.js';

/**
 * Builds the Fastify instance without listening, so tests can drive it through
 * `app.inject()` with no port to allocate and nothing to tear down.
 */
export function buildServer(env: Env, db: Db): FastifyInstance {
  const app = Fastify({ logger: env.NODE_ENV !== 'test' });

  app.register(cookie, { secret: env.SESSION_SECRET });
  app.register(rateLimit, { global: false });

  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof ApiError) {
      return reply.code(error.statusCode).send({ message: error.message });
    }
    // Anything unexpected is logged in full and answered generically: the frontend
    // puts `message` straight on the user's screen, so a stack trace or a Postgres
    // error there is a leak.
    app.log.error(error);
    return reply.code(500).send({ message: 'Внутренняя ошибка сервера' });
  });

  const guard = requireSession(db);

  app.get('/api/health', async () => ({ ok: true }));
  registerAuthRoutes(app, db, env, guard);
  // Later plans register their routes here, reusing the same guard.

  return app;
}
