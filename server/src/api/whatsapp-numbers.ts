import type { WebhookSetup, WhatsappNumber } from '@rakurs/contract';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { whatsappNumbers } from '../db/schema.js';
import type { Env } from '../env.js';
import { ApiError } from '../lib/errors.js';
import { credentialsKey, decryptSecret, encryptSecret } from '../lib/secret-box.js';
import { isUuid } from '../lib/uuid.js';
import {
  GraphError,
  withoutSecret,
  type GraphClient,
  type WebhookCallback,
} from '../lib/whatsapp/graph.js';
import { asCloudNumber, isCloudNumber } from '../lib/whatsapp/cloud-number.js';
import { requireAgent } from './require-agent.js';

/** Where Meta delivers this cabinet's WhatsApp webhooks, and the handshake secret for it. */
export const webhookCallback = (env: Env): WebhookCallback => ({
  url: `${env.PUBLIC_URL}/api/whatsapp/webhook`,
  verifyToken: env.META_WEBHOOK_VERIFY_TOKEN,
});

const connection = z.object({
  phoneNumberId: z.string().trim().min(1),
  wabaId: z.string().trim().min(1),
  accessToken: z.string().trim().min(1),
});

/**
 * Both fields optional, at least one required.
 *
 * A token expires — Meta's own temporary one lasts a day — and without a way to replace it
 * the only cure would be deleting the number, which cascades through the conversations and
 * takes every `ctwa_clid` with it. Meta hands that click identifier over exactly once.
 */
const settings = z
  .object({
    enabled: z.boolean().optional(),
    accessToken: z.string().trim().min(1).optional(),
  })
  .refine((body) => body.enabled !== undefined || body.accessToken !== undefined);

/**
 * The column holds text; the contract names three values. Anything else is a row written by
 * a version of this code that does not exist yet, and reading it as `manual` would describe
 * a number the cabinet cannot actually send through.
 */
const asConnectionKind = (value: string): WhatsappNumber['connectionKind'] => {
  if (value === 'coexistence' || value === 'linked') return value;
  return 'manual';
};

const asLinkedState = (value: string | null): WhatsappNumber['linkedState'] => {
  if (value === 'pairing' || value === 'open' || value === 'logged_out') return value;
  return null;
};

/** The access token is never part of this. It goes in and it does not come out. */
export const toApi = (row: typeof whatsappNumbers.$inferSelect): WhatsappNumber => ({
  id: row.id,
  phoneNumberId: row.phoneNumberId,
  wabaId: row.wabaId,
  displayPhone: row.displayPhone,
  enabled: row.enabled,
  subscribed: row.subscribedAt !== null,
  connectedAt: row.createdAt.toISOString(),
  connectionKind: asConnectionKind(row.connectionKind),
  linkedState: asLinkedState(row.linkedState),
  historyProgress: row.historyProgress,
  historyDeclined: row.historyDeclinedAt !== null,
  syncError: row.syncError,
  offboarded: row.offboardedAt !== null,
  tokenExpiresAt: row.tokenExpiresAt?.toISOString() ?? null,
});

/**
 * Postgres reports a unique violation with this code. Drizzle wraps the driver error in
 * its own `DrizzleQueryError`, so the code sits on `.cause`, not on the error itself.
 */
export const isDuplicate = (error: unknown): boolean => {
  const cause = error instanceof Error ? error.cause : undefined;
  return typeof cause === 'object' && cause !== null && (cause as { code?: string }).code === '23505';
};

/**
 * The 409 for a phone number that is already stored. The commonest way to get here is an
 * owner re-saving their own number, so say which agent holds it rather than sending them
 * looking for a colleague.
 */
export const duplicateNumberError = async (
  db: Db,
  phoneNumberId: string,
  agentId: string,
): Promise<ApiError> => {
  const [existing] = await db
    .select({ agentId: whatsappNumbers.agentId })
    .from(whatsappNumbers)
    .where(eq(whatsappNumbers.phoneNumberId, phoneNumberId));
  return new ApiError(
    409,
    existing?.agentId === agentId
      ? 'Этот номер уже подключён к этому агенту'
      : 'Этот номер уже подключён к другому агенту',
  );
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
          throw new ApiError(400, `Meta не приняла эти данные: ${withoutSecret(error.message, accessToken)}`);
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
            `Номер проверен, но не удалось подписать приложение на WABA: ${withoutSecret(error.message, accessToken)}`,
          );
        }
        throw error;
      }

      // The Meta app's own callback URL belongs to another product sharing the app, so the
      // number's webhooks are pointed here explicitly. Meta checks the address with a
      // handshake before accepting it.
      try {
        await graph.setWebhookOverride(phoneNumberId, accessToken, webhookCallback(env));
      } catch (error) {
        if (error instanceof GraphError) {
          throw new ApiError(
            400,
            `Номер проверен, но Meta не приняла адрес для входящих сообщений: ${withoutSecret(error.message, accessToken)}`,
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
        if (isDuplicate(error)) throw await duplicateNumberError(db, phoneNumberId, req.agent!.id);
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
      if (!isUuid(numberId)) throw new ApiError(404, 'Номер не найден');

      const parsed = settings.safeParse(req.body);
      if (!parsed.success) throw new ApiError(400, 'Не удалось разобрать настройку номера');
      const { enabled, accessToken } = parsed.data;

      // The agent condition is what stops one account editing another's number even
      // when the identifier is guessed.
      const owned = and(
        eq(whatsappNumbers.id, numberId),
        eq(whatsappNumbers.agentId, req.agent!.id),
      );

      const [current] = await db.select().from(whatsappNumbers).where(owned);
      if (!current) throw new ApiError(404, 'Номер не найден');

      if (accessToken !== undefined && current.connectionKind === 'coexistence') {
        // Meta issued this token during Embedded Signup; a pasted one would belong to a
        // different app or user and stop the phone's mirror from working.
        throw new ApiError(400, 'Токен этого номера выдаёт Meta при подключении с телефона, вручную его не заменить');
      }

      if (accessToken !== undefined && current.connectionKind === 'linked') {
        // There is no token at all: a linked device authenticates with a session, and the
        // way to renew that is to scan a QR code again.
        throw new ApiError(400, 'У номера, подключённого по QR, нет токена. Подключите телефон заново.');
      }

      const changes: Partial<typeof whatsappNumbers.$inferInsert> = {};
      if (enabled !== undefined) changes.enabled = enabled;

      if (accessToken !== undefined) {
        // Proved before anything is written: a mistyped token must leave the working one
        // in place, not replace it with one Meta will refuse on the next message.
        const cloud = asCloudNumber(current);
        let displayPhone: string;
        try {
          displayPhone = (await graph.getPhoneNumber(cloud.phoneNumberId, accessToken))
            .displayPhoneNumber;
        } catch (error) {
          if (error instanceof GraphError) {
            throw new ApiError(400, `Meta не приняла этот токен: ${withoutSecret(error.message, accessToken)}`);
          }
          throw error;
        }
        // The same associated data as the original: the row's identity has not changed,
        // only its secret. `subscribedAt` is left alone — the subscription belongs to the
        // WABA, not to the token that was used to request it.
        changes.accessToken = encryptSecret(accessToken, credentialsKey(env), cloud.phoneNumberId);
        changes.displayPhone = displayPhone;
      }

      const [row] = await db.update(whatsappNumbers).set(changes).where(owned).returning();

      if (!row) throw new ApiError(404, 'Номер не найден');
      return toApi(row);
    },
  );

  app.delete(
    '/api/agents/:agentId/whatsapp/numbers/:numberId',
    { preHandler: [guard, ownerOnly] },
    async (req): Promise<{ ok: true }> => {
      const { numberId } = req.params as { numberId: string };
      if (!isUuid(numberId)) throw new ApiError(404, 'Номер не найден');

      const owned = and(eq(whatsappNumbers.id, numberId), eq(whatsappNumbers.agentId, req.agent!.id));
      const [current] = await db.select().from(whatsappNumbers).where(owned);
      if (!current) throw new ApiError(404, 'Номер не найден');

      // Hand the number's webhooks back to the app default, so whatever used the number
      // before it was connected here hears its messages again. Best effort: an expired or
      // unreadable token must not keep an owner from removing the number.
      if (isCloudNumber(current)) {
        try {
          const token = decryptSecret(current.accessToken, credentialsKey(env), current.phoneNumberId);
          await graph.setWebhookOverride(current.phoneNumberId, token, null);
        } catch {
          // Nothing to do: the row goes regardless, and Meta keeps delivering to this cabinet,
          // which now drops messages for a number it no longer has.
        }
      }

      const [row] = await db
        .delete(whatsappNumbers)
        .where(owned)
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
    async (): Promise<WebhookSetup> => webhookCallback(env),
  );
}
