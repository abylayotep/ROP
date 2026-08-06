import Fastify, { type FastifyInstance } from 'fastify';
import type { Env } from '../env.js';

/**
 * Builds the Fastify instance without listening, so tests can drive it through
 * `app.inject()` with no port to allocate and nothing to tear down.
 */
export function buildServer(env: Env): FastifyInstance {
  const app = Fastify({ logger: env.NODE_ENV !== 'test' });

  app.get('/api/health', async () => ({ ok: true }));

  return app;
}
