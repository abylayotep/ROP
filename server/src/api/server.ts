import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Db } from '../db/client.js';
import type { Env } from '../env.js';
import { ApiError } from '../lib/errors.js';
import { credentialsKey } from '../lib/secret-box.js';
import { createGraphClient, type GraphClient } from '../lib/whatsapp/graph.js';
import { registerAgentRoutes } from './agents.js';
import { registerAuthRoutes } from './auth.js';
import { registerBoardRoutes } from './board.js';
import { registerConversationRoutes } from './conversations.js';
import { registerKnowledgeRoutes } from './knowledge.js';
import { registerLeadRoutes } from './leads.js';
import { registerOrderRoutes } from './orders.js';
import { requireSession } from './require-session.js';
import { registerStageRoutes } from './stages.js';
import { registerWhatsappNumberRoutes } from './whatsapp-numbers.js';
import { registerWhatsappWebhook } from './whatsapp-webhook.js';

export interface ServerDeps {
  /** Injected by tests so a suite never reaches the network. Defaults to the real client. */
  graph?: GraphClient;
}

/**
 * Builds the Fastify instance without listening, so tests can drive it through
 * `app.inject()` with no port to allocate and nothing to tear down.
 */
export function buildServer(env: Env, db: Db, deps: ServerDeps = {}): FastifyInstance {
  const app = Fastify({ logger: env.NODE_ENV !== 'test' });
  const graph = deps.graph ?? createGraphClient();

  app.register(cookie, { secret: env.SESSION_SECRET });
  app.register(rateLimit, { global: false });

  // Fastify's built-in 404 body is English developer text ("Route GET:/api/… not
  // found"), and the frontend renders `message` verbatim. Routes that genuinely
  // cannot find a record raise their own ApiError with their own wording; this only
  // catches paths no route claims at all.
  app.setNotFoundHandler((_req, reply) =>
    reply.code(404).send({ message: 'Раздел ещё не подключён' }),
  );

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
  registerAgentRoutes(app, db, guard);
  registerWhatsappNumberRoutes(app, db, env, guard, graph);
  registerConversationRoutes(app, db, env, guard, graph);
  registerStageRoutes(app, db, guard);
  registerLeadRoutes(app, db, env, guard, graph);
  registerOrderRoutes(app, db, guard);
  registerBoardRoutes(app, db, guard);
  registerKnowledgeRoutes(app, db, guard);
  // Meta calls the webhook directly with no session of its own, so it takes no guard —
  // the request signature is the check instead.
  registerWhatsappWebhook(app, db, env, {
    graph,
    key: credentialsKey(env),
    mediaDir: env.MEDIA_DIR,
  });
  // Later plans register their routes here, reusing the same guard.

  return app;
}
