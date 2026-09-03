import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/client.js';
import { whatsappEvents } from '../db/schema.js';
import type { Env } from '../env.js';
import { sendPendingCapiEvents, type CapiQueueDeps } from '../lib/capi/queue.js';
import { type InboundDeps, processPendingEvents } from '../lib/whatsapp/inbound.js';
import { verifySignature } from '../lib/whatsapp/signature.js';

/**
 * Meta's two webhook routes.
 *
 * They live in their own Fastify scope because this is the one place in the product that needs
 * the raw request body: the signature is over the bytes Meta sent, and Fastify's default JSON
 * parser hands back an object those bytes cannot be recovered from. A content-type parser
 * registered inside a scope applies only there, so the rest of the API keeps receiving parsed
 * JSON exactly as before.
 *
 * There is no session guard here by design — Meta has no session. The signature is the check.
 */
export function registerWhatsappWebhook(
  app: FastifyInstance,
  db: Db,
  env: Env,
  deps: InboundDeps,
  capiDeps: CapiQueueDeps,
): void {
  app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (_req, body, done) => done(null, body),
    );

    /**
     * The handshake. Meta calls this once when the webhook address is saved and expects the
     * challenge echoed as plain text — a JSON body, even one containing the right number,
     * fails verification.
     */
    scope.get('/api/whatsapp/webhook', async (req, reply) => {
      const query = req.query as Record<string, string | undefined>;

      if (
        query['hub.mode'] === 'subscribe' &&
        query['hub.verify_token'] === env.META_WEBHOOK_VERIFY_TOKEN
      ) {
        return reply.type('text/plain').send(query['hub.challenge'] ?? '');
      }
      return reply.code(403).send();
    });

    scope.post('/api/whatsapp/webhook', async (req, reply) => {
      const raw = req.body as Buffer;

      if (!verifySignature(raw, req.headers['x-hub-signature-256'] as string | undefined, env.META_APP_SECRET)) {
        // Deliberately terse: an attacker probing the endpoint learns nothing from it.
        return reply.code(401).send();
      }

      let payload: unknown;
      try {
        payload = JSON.parse(raw.toString('utf8'));
      } catch {
        // Signed by us, yet not JSON. Retrying will not help, so do not ask Meta to.
        return reply.code(400).send();
      }

      await db.insert(whatsappEvents).values({ payload });

      // Answer first, work second. Meta retries only on a non-200, and the event is already
      // stored, so nothing is lost if this throws — the row keeps its error for a re-run.
      //
      // The Conversions API drain rides here too, behind the response and after the pass,
      // rather than on the path of the operator's own action: this is the one thing in the
      // product that runs often enough to be a schedule. After the pass and not before it,
      // because the pass is what queues a lead — the agent moving a conversation into a
      // qualified stage is a turn that runs inside it — so a report queued by this delivery
      // goes out in this drain rather than waiting for the next customer to write.
      setImmediate(() => {
        void (async () => {
          try {
            await processPendingEvents(db, deps);
          } catch (error) {
            app.log.error({ error }, 'whatsapp: processing pending events failed');
          }
          try {
            await sendPendingCapiEvents(db, capiDeps);
          } catch (error) {
            // Caught separately: a delivery this process could not apply must not also cost
            // every already-queued sale its report.
            app.log.error({ error }, 'capi: draining pending events failed');
          }
        })();
      });

      return reply.code(200).send();
    });
  });
}
