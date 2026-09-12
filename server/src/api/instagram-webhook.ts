import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/client.js';
import { instagramEvents } from '../db/schema.js';
import type { Env } from '../env.js';
import type { TurnDeps } from '../lib/ai/turn.js';
import { processPendingInstagramEvents } from '../lib/instagram/inbound.js';
import { verifySignature } from '../lib/whatsapp/signature.js';

export function registerInstagramWebhook(app: FastifyInstance, db: Db, env: Env, deps: TurnDeps): void {
  app.register(async (scope) => {
    scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
    scope.get('/api/instagram/webhook', async (req, reply) => {
      const query = req.query as Record<string, string | undefined>;
      if (query['hub.mode'] === 'subscribe' && query['hub.verify_token'] === env.META_WEBHOOK_VERIFY_TOKEN) {
        return reply.type('text/plain').send(query['hub.challenge'] ?? '');
      }
      return reply.code(403).send();
    });
    scope.post('/api/instagram/webhook', async (req, reply) => {
      const raw = req.body as Buffer;
      if (!verifySignature(raw, req.headers['x-hub-signature-256'] as string | undefined, env.META_APP_SECRET)) return reply.code(401).send();
      let payload: unknown;
      try { payload = JSON.parse(raw.toString('utf8')); }
      catch { return reply.code(400).send(); }
      if ((payload as { object?: string }).object !== 'instagram') return reply.code(400).send();
      await db.insert(instagramEvents).values({ payload });
      setImmediate(() => void processPendingInstagramEvents(db, deps).catch((error) => app.log.error({ error }, 'instagram: processing events failed')));
      return reply.code(200).send();
    });
  });
}
