import type { CoexistenceConnection, EmbeddedSignupSetup, WhatsappNumber } from '@rakurs/contract';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { whatsappNumbers } from '../db/schema.js';
import type { Env } from '../env.js';
import { ApiError } from '../lib/errors.js';
import { credentialsKey, encryptSecret } from '../lib/secret-box.js';
import {
  GraphError,
  withoutSecret,
  type GraphClient,
  type IssuedToken,
  type PhoneNumber,
} from '../lib/whatsapp/graph.js';
import { requireAgent } from './require-agent.js';
import { duplicateNumberError, isDuplicate, toApi } from './whatsapp-numbers.js';

const connection = z.object({
  code: z.string().trim().min(1),
  wabaId: z.string().trim().min(1),
  phoneNumberId: z.string().trim().min(1).optional(),
  businessId: z.string().trim().min(1).optional(),
});

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
      const { code, wabaId, businessId, phoneNumberId } = parsed.data;

      let issued: IssuedToken;
      try {
        issued = await graph.exchangeCode(code, env.META_APP_ID, env.META_APP_SECRET);
      } catch (error) {
        if (error instanceof GraphError) {
          throw new ApiError(400, `Meta не приняла подтверждение: ${withoutSecret(error.message, env.META_APP_SECRET)}`);
        }
        throw error;
      }
      const token = issued.token;

      // The finish event of the coexistence flow may carry only the WABA. One number on it
      // is the common case; two is the owner's choice to make in Meta's own window.
      let number: PhoneNumber;
      try {
        if (phoneNumberId) {
          // The browser named both the WABA and the number, and neither is trusted. Without
          // this check an owner could file someone else's number under their own WABA — the
          // token would still work, and every later call would be made against the wrong
          // account.
          const all = await graph.listPhoneNumbers(wabaId, token);
          if (!all.some((p) => p.id === phoneNumberId)) {
            throw new ApiError(400, 'Номер не принадлежит выбранному аккаунту WhatsApp Business');
          }
          number = await graph.getPhoneNumber(phoneNumberId, token);
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

      const secret = encryptSecret(token, credentialsKey(env), number.id);

      // Running Embedded Signup again on a number we already hold is a renewal, not a
      // mistake: Meta's sixty-day token has no other cure, and the button the owner is
      // told to press is this same button. Only the owner's own coexistence number is
      // renewed — a manual number is a deliberate setup with a system-user token, and
      // another agent's number is not this owner's to take.
      const [existing] = await db
        .select()
        .from(whatsappNumbers)
        .where(eq(whatsappNumbers.phoneNumberId, number.id));
      if (existing) {
        if (existing.agentId !== req.agent!.id || existing.connectionKind !== 'coexistence') {
          throw await duplicateNumberError(db, number.id, req.agent!.id);
        }
        const [renewed] = await db
          .update(whatsappNumbers)
          .set({
            accessToken: secret,
            tokenExpiresAt: issued.expiresAt,
            displayPhone: number.displayPhoneNumber,
            wabaId,
            businessId: businessId ?? existing.businessId,
            subscribedAt: new Date(),
          })
          .where(eq(whatsappNumbers.id, existing.id))
          .returning();
        // No `smb_app_data` here. Both requests are one-shot on Meta's side; asking again
        // would trade a clean row for «already requested» in red, and the contacts and
        // history this number has are already in the cabinet.
        return toApi(renewed!);
      }

      let row: typeof whatsappNumbers.$inferSelect;
      try {
        const inserted = await db
          .insert(whatsappNumbers)
          .values({
            agentId: req.agent!.id,
            phoneNumberId: number.id,
            wabaId,
            businessId: businessId ?? null,
            displayPhone: number.displayPhoneNumber,
            accessToken: secret,
            tokenExpiresAt: issued.expiresAt,
            subscribedAt: new Date(),
            connectionKind: 'coexistence',
          })
          .returning();
        row = inserted[0]!;
      } catch (error) {
        // Still guarded: the select above and this insert are not one transaction, and two
        // finished signup windows arriving together would both find nothing.
        if (isDuplicate(error)) throw await duplicateNumberError(db, number.id, req.agent!.id);
        throw error;
      }

      // Both are one-shot on Meta's side and independent of each other, so a refusal of one
      // must not forfeit the other against Meta's 24-hour deadline. Errors are written down,
      // not retried: a second attempt would only replace a clear error with «already
      // requested».
      const failures: string[] = [];
      for (const syncType of ['smb_app_state_sync', 'history'] as const) {
        try {
          await graph.requestSmbAppData(number.id, token, syncType);
        } catch (error) {
          if (!(error instanceof GraphError)) throw error;
          failures.push(withoutSecret(error.message, token));
        }
      }
      const syncError = failures.length > 0 ? failures.join('; ') : null;
      const [updated] = await db
        .update(whatsappNumbers)
        .set(syncError ? { syncError } : { syncRequestedAt: new Date() })
        .where(eq(whatsappNumbers.id, row.id))
        .returning();
      return toApi(updated!);
    },
  );
}
