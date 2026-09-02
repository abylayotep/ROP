import type { WebhookSetup, WhatsappNumber } from '@rakurs/contract';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { whatsappNumbers } from '../db/schema.js';
import type { Env } from '../env.js';
import { ApiError } from '../lib/errors.js';
import { credentialsKey, encryptSecret } from '../lib/secret-box.js';
import { GraphError, type GraphClient } from '../lib/whatsapp/graph.js';
import { requireAgent } from './require-agent.js';

const connection = z.object({
  phoneNumberId: z.string().trim().min(1),
  wabaId: z.string().trim().min(1),
  accessToken: z.string().trim().min(1),
});

const enabling = z.object({ enabled: z.boolean() });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The access token is never part of this. It goes in and it does not come out. */
const toApi = (row: typeof whatsappNumbers.$inferSelect): WhatsappNumber => ({
  id: row.id,
  phoneNumberId: row.phoneNumberId,
  wabaId: row.wabaId,
  displayPhone: row.displayPhone,
  enabled: row.enabled,
  subscribed: row.subscribedAt !== null,
  connectedAt: row.createdAt.toISOString(),
});

/**
 * Postgres reports a unique violation with this code. Drizzle wraps the driver error in
 * its own `DrizzleQueryError`, so the code sits on `.cause`, not on the error itself.
 */
const isDuplicate = (error: unknown): boolean => {
  const cause = error instanceof Error ? error.cause : undefined;
  return typeof cause === 'object' && cause !== null && (cause as { code?: string }).code === '23505';
};

export function registerWhatsappNumberRoutes(
  app: FastifyInstance,
  db: Db,
  env: Env,
  guard: preHandlerHookHandler,
  graph: GraphClient,
): void {
  const anyMember = requireAgent(db);
  const ownerOnly = requireAgent(db, { role: 'owner' });

  app.get(
    '/api/agents/:agentId/whatsapp/numbers',
    { preHandler: [guard, anyMember] },
    async (req): Promise<WhatsappNumber[]> => {
      const rows = await db
        .select()
        .from(whatsappNumbers)
        .where(eq(whatsappNumbers.agentId, req.agent!.id))
        .orderBy(whatsappNumbers.createdAt);
      return rows.map(toApi);
    },
  );

  app.post(
    '/api/agents/:agentId/whatsapp/numbers',
    { preHandler: [guard, ownerOnly] },
    async (req): Promise<WhatsappNumber> => {
      const parsed = connection.safeParse(req.body);
      if (!parsed.success) throw new ApiError(400, 'Заполните все три поля');
      const { phoneNumberId, wabaId, accessToken } = parsed.data;

      // Prove the token before storing anything. A number saved with a token Meta rejects
      // would sit in the cabinet looking connected.
      let displayPhone: string;
      try {
        displayPhone = (await graph.getPhoneNumber(phoneNumberId, accessToken)).displayPhoneNumber;
      } catch (error) {
        if (error instanceof GraphError) {
          throw new ApiError(400, `Meta не приняла эти данные: ${error.message}`);
        }
        throw error;
      }

      // The step everyone forgets. Without it Meta accepts the connection and delivers
      // nothing, which is indistinguishable from working until a client writes.
      try {
        await graph.subscribeApp(wabaId, accessToken);
      } catch (error) {
        if (error instanceof GraphError) {
          throw new ApiError(
            400,
            `Номер проверен, но не удалось подписать приложение на WABA: ${error.message}`,
          );
        }
        throw error;
      }

      try {
        const [row] = await db
          .insert(whatsappNumbers)
          .values({
            agentId: req.agent!.id,
            phoneNumberId,
            wabaId,
            displayPhone,
            // Bound to the phone number id: a token copied into another number's row
            // will not decrypt there.
            accessToken: encryptSecret(accessToken, credentialsKey(env), phoneNumberId),
            subscribedAt: new Date(),
          })
          .returning();
        return toApi(row!);
      } catch (error) {
        if (isDuplicate(error)) {
          throw new ApiError(409, 'Этот номер уже подключён к другому агенту');
        }
        throw error;
      }
    },
  );

  app.patch(
    '/api/agents/:agentId/whatsapp/numbers/:numberId',
    { preHandler: [guard, ownerOnly] },
    async (req): Promise<WhatsappNumber> => {
      const { numberId } = req.params as { numberId: string };
      // A numberId that is not a uuid makes Postgres raise on the comparison, which would
      // turn a typo into a 500.
      if (!UUID.test(numberId)) throw new ApiError(404, 'Номер не найден');

      const parsed = enabling.safeParse(req.body);
      if (!parsed.success) throw new ApiError(400, 'Не удалось разобрать настройку номера');

      const [row] = await db
        .update(whatsappNumbers)
        .set({ enabled: parsed.data.enabled })
        // The agent condition is what stops one account editing another's number even
        // when the identifier is guessed.
        .where(and(eq(whatsappNumbers.id, numberId), eq(whatsappNumbers.agentId, req.agent!.id)))
        .returning();

      if (!row) throw new ApiError(404, 'Номер не найден');
      return toApi(row);
    },
  );

  app.delete(
    '/api/agents/:agentId/whatsapp/numbers/:numberId',
    { preHandler: [guard, ownerOnly] },
    async (req): Promise<{ ok: true }> => {
      const { numberId } = req.params as { numberId: string };
      if (!UUID.test(numberId)) throw new ApiError(404, 'Номер не найден');

      const [row] = await db
        .delete(whatsappNumbers)
        .where(and(eq(whatsappNumbers.id, numberId), eq(whatsappNumbers.agentId, req.agent!.id)))
        .returning({ id: whatsappNumbers.id });

      if (!row) throw new ApiError(404, 'Номер не найден');
      return { ok: true };
    },
  );

  app.get(
    '/api/agents/:agentId/whatsapp/setup',
    // Owner only: the verification string is a shared secret with Meta, and anyone holding
    // it plus the address can complete a handshake in our name.
    { preHandler: [guard, ownerOnly] },
    async (): Promise<WebhookSetup> => ({
      url: `${env.PUBLIC_URL}/api/whatsapp/webhook`,
      verifyToken: env.META_WEBHOOK_VERIFY_TOKEN,
    }),
  );
}
