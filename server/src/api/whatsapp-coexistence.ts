import type { CoexistenceConnection, EmbeddedSignupSetup, WhatsappNumber } from '@rakurs/contract';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { whatsappNumbers } from '../db/schema.js';
import type { Env } from '../env.js';
import { ApiError } from '../lib/errors.js';
import { credentialsKey, encryptSecret } from '../lib/secret-box.js';
import { GraphError, withoutSecret, type GraphClient, type PhoneNumber } from '../lib/whatsapp/graph.js';
import { requireAgent } from './require-agent.js';
import { toApi } from './whatsapp-numbers.js';

const connection = z.object({
  code: z.string().trim().min(1),
  wabaId: z.string().trim().min(1),
  phoneNumberId: z.string().trim().min(1).optional(),
  businessId: z.string().trim().min(1).optional(),
});

const isDuplicate = (error: unknown): boolean => {
  const cause = error instanceof Error ? error.cause : undefined;
  return typeof cause === 'object' && cause !== null && (cause as { code?: string }).code === '23505';
};

/**
 * Coexistence: the number that already lives in the WhatsApp Business app on a phone.
 *
 * Embedded Signup ran in the browser and produced a code that dies in thirty seconds. This
 * route spends it: token, number, subscription, row, and both one-shot sync requests, in one
 * go. Nothing here is deferred to a job, because Meta's 24-hour deadline on the syncs is a
 * cliff and a queue is one more place to fall off it.
 */
export function registerWhatsappCoexistenceRoutes(
  app: FastifyInstance,
  db: Db,
  env: Env,
  guard: preHandlerHookHandler,
  graph: GraphClient,
): void {
  const ownerOnly = requireAgent(db, { role: 'owner' });

  app.get(
    '/api/agents/:agentId/whatsapp/embedded-signup',
    { preHandler: [guard, ownerOnly] },
    async (): Promise<EmbeddedSignupSetup> => ({
      appId: env.META_APP_ID,
      configId: env.META_ES_CONFIG_ID,
    }),
  );

  app.post(
    '/api/agents/:agentId/whatsapp/coexistence',
    { preHandler: [guard, ownerOnly] },
    async (req): Promise<WhatsappNumber> => {
      const parsed = connection.safeParse(req.body as CoexistenceConnection);
      if (!parsed.success) throw new ApiError(400, 'Meta не вернула данные для подключения');
      const { code, wabaId, businessId } = parsed.data;

      let token: string;
      try {
        token = await graph.exchangeCode(code, env.META_APP_ID, env.META_APP_SECRET);
      } catch (error) {
        if (error instanceof GraphError) {
          throw new ApiError(400, `Meta не приняла подтверждение: ${withoutSecret(error.message, env.META_APP_SECRET)}`);
        }
        throw error;
      }

      // The finish event of the coexistence flow may carry only the WABA. One number on it
      // is the common case; two is the owner's choice to make in Meta's own window.
      let number: PhoneNumber;
      try {
        if (parsed.data.phoneNumberId) {
          number = await graph.getPhoneNumber(parsed.data.phoneNumberId, token);
        } else {
          const all = await graph.listPhoneNumbers(wabaId, token);
          if (all.length !== 1) {
            throw new ApiError(400, 'У аккаунта несколько номеров. Повторите подключение и выберите номер в окне Meta.');
          }
          number = await graph.getPhoneNumber(all[0]!.id, token);
        }
      } catch (error) {
        if (error instanceof GraphError) {
          throw new ApiError(400, `Meta не отдала номер: ${withoutSecret(error.message, token)}`);
        }
        throw error;
      }

      if (!number.isOnBizApp) {
        throw new ApiError(400, 'Номер не подключён к приложению WhatsApp Business на телефоне');
      }

      try {
        await graph.subscribeApp(wabaId, token);
      } catch (error) {
        if (error instanceof GraphError) {
          throw new ApiError(400, `Номер проверен, но не удалось подписать приложение на WABA: ${withoutSecret(error.message, token)}`);
        }
        throw error;
      }

      let row: typeof whatsappNumbers.$inferSelect;
      try {
        [row] = (await db
          .insert(whatsappNumbers)
          .values({
            agentId: req.agent!.id,
            phoneNumberId: number.id,
            wabaId,
            businessId: businessId ?? null,
            displayPhone: number.displayPhoneNumber,
            accessToken: encryptSecret(token, credentialsKey(env), number.id),
            subscribedAt: new Date(),
            connectionKind: 'coexistence',
          })
          .returning()) as [typeof whatsappNumbers.$inferSelect];
      } catch (error) {
        if (isDuplicate(error)) {
          const [existing] = await db
            .select({ agentId: whatsappNumbers.agentId })
            .from(whatsappNumbers)
            .where(eq(whatsappNumbers.phoneNumberId, number.id));
          throw new ApiError(
            409,
            existing?.agentId === req.agent!.id
              ? 'Этот номер уже подключён к этому агенту'
              : 'Этот номер уже подключён к другому агенту',
          );
        }
        throw error;
      }

      // Both are one-shot on Meta's side. A refusal is written down, not retried: a second
      // attempt would only replace a clear error with «already requested».
      let syncError: string | null = null;
      for (const syncType of ['smb_app_state_sync', 'history'] as const) {
        try {
          await graph.requestSmbAppData(number.id, token, syncType);
        } catch (error) {
          if (!(error instanceof GraphError)) throw error;
          syncError = withoutSecret(error.message, token);
          break;
        }
      }
      const [updated] = await db
        .update(whatsappNumbers)
        .set(syncError ? { syncError } : { syncRequestedAt: new Date() })
        .where(eq(whatsappNumbers.id, row.id))
        .returning();
      return toApi(updated!);
    },
  );
}
