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
import { createInstagramClient, type InstagramClient } from '../lib/instagram/graph.js';
import { createGraphClient, type GraphClient } from '../lib/whatsapp/graph.js';
import { registerAgentRoutes } from './agents.js';
import { registerAiRoutes } from './ai.js';
import { registerAuthRoutes } from './auth.js';
import { registerBoardRoutes } from './board.js';
import { registerCapiRoutes } from './capi.js';
import { registerCoachRoutes } from './coach.js';
import { registerConversationRoutes } from './conversations.js';
import { registerDraftRoutes } from './drafts.js';
import { registerKnowledgeRoutes } from './knowledge.js';
import { registerKnowledgeGenerationRoutes } from './knowledge-generation.js';
import { registerLeadRoutes } from './leads.js';
import { registerOrderRoutes } from './orders.js';
import { requireSession } from './require-session.js';
import { registerRuleRoutes } from './rules.js';
import { registerStageRoutes } from './stages.js';
import { registerStatsRoutes } from './stats.js';
import { registerTestCaseRoutes } from './test-cases.js';
import { registerWhatsappCoexistenceRoutes } from './whatsapp-coexistence.js';
import { registerWhatsappNumberRoutes } from './whatsapp-numbers.js';
import { registerWhatsappWebhook } from './whatsapp-webhook.js';
import { createLinkedClient, type LinkedRegistry } from '../lib/whatsapp/linked/client.js';
import { createLinkedSocket } from '../lib/whatsapp/linked/socket.js';
import { registerWhatsappLinkedRoutes } from './whatsapp-linked.js';
import { registerWhatsappHistoryRoutes } from './whatsapp-history.js';
import multipart from '@fastify/multipart';

export interface ServerDeps {
  /** Injected by tests so a suite never reaches the network. Defaults to the real client. */
  graph?: GraphClient;
  /** The same arrangement for the knowledge base's one outbound fetch. */
  pageFetcher?: PageFetcher;
  /** And for Instagram: no test asks Meta for somebody's posts. */
  instagram?: InstagramClient;
  /** And for the model: no test spends a token or depends on a live OpenRouter key. */
  model?: ModelClient;
  /** And for Meta's Conversions API: no test reports a conversion to a real dataset. */
  capi?: CapiClient;
  /** And for the phones: no test opens a socket to WhatsApp. */
  linked?: LinkedRegistry;
  /** How long a pairing may go unscanned. Shortened by tests, five minutes otherwise. */
  pairingTimeoutMs?: number;
  historyTimeoutMs?: number;
  historyPaceMs?: number;
}

/**
 * Builds the Fastify instance without listening, so tests can drive it through
 * `app.inject()` with no port to allocate and nothing to tear down.
 */
export function buildServer(env: Env, db: Db, deps: ServerDeps = {}): FastifyInstance {
  const app = Fastify({ logger: env.NODE_ENV !== 'test' });
  const graph = deps.graph ?? createGraphClient();
  const pageFetcher = deps.pageFetcher ?? createPageFetcher();
  const instagram = deps.instagram ?? createInstagramClient();
  // Taken the same way every other outbound client is: the AI routes and the inbound queue
  // both answer with it, and a test replaces it once for both.
  const model = deps.model ?? createModelClient();
  // Resolved here, alongside every other outbound client, so the settings routes and the
  // queue drain share one instance and a test replaces it once for all of them.
  const capi = deps.capi ?? createCapiClient();
  // One registry for the whole process: it owns the live sockets, and two of them would
  // mean two devices claiming one number.
  const linked =
    deps.linked ?? createLinkedClient({ session: createLinkedSocket(db, credentialsKey(env)) });

  app.register(cookie, { secret: env.SESSION_SECRET });
  // Only the one route reads a file part; registered here because a content-type parser
  // has to exist before any route that needs it is added.
  app.register(multipart, { limits: { files: 1, fileSize: 16 * 1024 * 1024 } });
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
    registerWhatsappCoexistenceRoutes(app, db, env, guard, graph);
    registerWhatsappLinkedRoutes(app, db, env, guard, linked, { timeoutMs: deps.pairingTimeoutMs });
    registerWhatsappHistoryRoutes(app, db, guard, linked, {
      timeoutMs: deps.historyTimeoutMs,
      paceMs: deps.historyPaceMs,
    });
    registerConversationRoutes(app, db, env, guard, graph, linked);
    registerStageRoutes(app, db, guard);
    registerLeadRoutes(app, db, env, guard, graph);
    registerOrderRoutes(app, db, guard);
    registerBoardRoutes(app, db, guard);
    registerStatsRoutes(app, db, guard);
    registerKnowledgeRoutes(app, db, env, guard, { pageFetcher, graph, instagram });
    registerKnowledgeGenerationRoutes(app, db, env, guard, { model });
    registerRuleRoutes(app, db, guard);
    registerAiRoutes(app, db, env, guard, { model, graph, linked });
    // The coach writes only `coach_messages` — see the file's own comment for why a
    // proposal never reaches `agent_rules` or `kb_notes` from here.
    registerCoachRoutes(app, db, env, guard, { model });
    // Drafts, their cases and their runs — including `POST …/coach/messages/:id/draft`,
    // which turns a checked proposal into the one thing the coach itself never writes.
    registerDraftRoutes(app, db, env, guard, { model, graph, linked });
    // The conversations a draft is proven against — kept by hand, pulled from a real dialog,
    // or suggested by the model. Registered beside the drafts it serves.
    registerTestCaseRoutes(app, db, env, guard, { model });
    // The same client the drain sends with, so a save is verified against the Meta a
    // report will actually reach.
    registerCapiRoutes(app, db, env, guard, capi);
    // Meta calls the webhook directly with no session of its own, so it takes no guard —
    // the request signature is the check instead.
    registerWhatsappWebhook(
      app,
      db,
      env,
      { graph, linked, key: credentialsKey(env), mediaDir: env.MEDIA_DIR, model },
      // The Conversions API queue is drained by the same delivery, once Meta has its 200.
      { capi, key: credentialsKey(env) },
    );
    // Later plans register their routes here, reusing the same guard.
  });

  return app;
}
