import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Db } from '../db/client.js';
import type { Env } from '../env.js';
import { createModelClient, type ModelClient } from '../lib/ai/openrouter.js';
import { createCapiClient, type CapiClient } from '../lib/capi/client.js';
import { ApiError } from '../lib/errors.js';
import { createPageFetcher, type PageFetcher } from '../lib/knowledge/fetch-page.js';
import { credentialsKey } from '../lib/secret-box.js';
import { createGraphClient, type GraphClient } from '../lib/whatsapp/graph.js';
import { registerAgentRoutes } from './agents.js';
import { registerAiRoutes } from './ai.js';
import { registerAuthRoutes } from './auth.js';
import { registerBoardRoutes } from './board.js';
import { registerCapiRoutes } from './capi.js';
import { registerConversationRoutes } from './conversations.js';
import { registerKnowledgeRoutes } from './knowledge.js';
import { registerLeadRoutes } from './leads.js';
import { registerOrderRoutes } from './orders.js';
import { requireSession } from './require-session.js';
import { registerStageRoutes } from './stages.js';
import { registerStatsRoutes } from './stats.js';
import { registerWhatsappNumberRoutes } from './whatsapp-numbers.js';
import { registerWhatsappWebhook } from './whatsapp-webhook.js';

export interface ServerDeps {
  /** Injected by tests so a suite never reaches the network. Defaults to the real client. */
  graph?: GraphClient;
  /** The same arrangement for the knowledge base's one outbound fetch. */
  pageFetcher?: PageFetcher;
  /** And for the model: no test spends a token or depends on a live OpenRouter key. */
  model?: ModelClient;
  /** And for Meta's Conversions API: no test reports a conversion to a real dataset. */
  capi?: CapiClient;
}

/**
 * Builds the Fastify instance without listening, so tests can drive it through
 * `app.inject()` with no port to allocate and nothing to tear down.
 */
export function buildServer(env: Env, db: Db, deps: ServerDeps = {}): FastifyInstance {
  const app = Fastify({ logger: env.NODE_ENV !== 'test' });
  const graph = deps.graph ?? createGraphClient();
  const pageFetcher = deps.pageFetcher ?? createPageFetcher();
  // Taken the same way every other outbound client is: the AI routes and the inbound queue
  // both answer with it, and a test replaces it once for both.
  const model = deps.model ?? createModelClient();
  // Resolved here, alongside every other outbound client, so the settings routes and the
  // queue drain share one instance and a test replaces it once for all of them.
  const capi = deps.capi ?? createCapiClient();

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
    // The rate limiter throws its own error rather than an ApiError, so without this a
    // person who mistyped their password five times reads «Внутренняя ошибка сервера» and
    // has no idea to wait. Every rate-limited route is affected, not only login.
    if (error instanceof Error && 'statusCode' in error && error.statusCode === 429) {
      return reply.code(429).send({ message: 'Слишком много попыток. Подождите минуту.' });
    }
    // Anything unexpected is logged in full and answered generically: the frontend
    // puts `message` straight on the user's screen, so a stack trace or a Postgres
    // error there is a leak.
    app.log.error(error);
    return reply.code(500).send({ message: 'Внутренняя ошибка сервера' });
  });

  const guard = requireSession(db);

  app.get('/api/health', async () => ({ ok: true }));

  /*
   * Routes are added inside `after`, once the plugins above have finished loading.
   *
   * Fastify defers a `register`, so a route added on the next line goes onto an instance the
   * rate limiter has not decorated yet, and its per-route `config.rateLimit` is then ignored
   * without a word. That is how the login route spent four stages looking rate limited while
   * accepting an unlimited number of wrong passwords — fourteen in a row, all answered 401.
   */
  app.after(() => {
    registerAuthRoutes(app, db, env, guard);
    registerAgentRoutes(app, db, guard);
    registerWhatsappNumberRoutes(app, db, env, guard, graph);
    registerConversationRoutes(app, db, env, guard, graph);
    registerStageRoutes(app, db, guard);
    registerLeadRoutes(app, db, env, guard, graph);
    registerOrderRoutes(app, db, guard);
    registerBoardRoutes(app, db, guard);
    registerStatsRoutes(app, db, guard);
    registerKnowledgeRoutes(app, db, guard, pageFetcher);
    registerAiRoutes(app, db, env, guard, { model, graph });
    // The same client the drain sends with, so a save is verified against the Meta a
    // report will actually reach.
    registerCapiRoutes(app, db, env, guard, capi);
    // Meta calls the webhook directly with no session of its own, so it takes no guard —
    // the request signature is the check instead.
    registerWhatsappWebhook(
      app,
      db,
      env,
      { graph, key: credentialsKey(env), mediaDir: env.MEDIA_DIR, model },
      // The Conversions API queue is drained by the same delivery, once Meta has its 200.
      { capi, key: credentialsKey(env) },
    );
    // Later plans register their routes here, reusing the same guard.
  });

  return app;
}
