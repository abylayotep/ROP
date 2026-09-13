/**
 * Where an agent's conversions go, what became of them, and the one button that sends a
 * report again.
 *
 * The token follows the path `whatsapp-numbers.ts` settled on and `ai.ts` repeated: it goes
 * in, it is sealed to the row it belongs to, and it does not come out. What a reader is told
 * is whether one is stored.
 */
import type { CapiEvent, CapiSettings } from '@rakurs/contract';
import { and, asc, desc, eq, isNotNull, type SQL } from 'drizzle-orm';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import {
  capiEvents,
  capiSettings,
  contacts,
  conversations,
  orders,
  whatsappNumbers,
} from '../db/schema.js';
import type { Env } from '../env.js';
import { CapiError, type CapiClient } from '../lib/capi/client.js';
import { UNREPORTABLE_BODY, buildLead, serialiseEvent } from '../lib/capi/events.js';
import { tokenAad } from '../lib/capi/queue.js';
import { ApiError } from '../lib/errors.js';
import { credentialsKey, decryptSecret, encryptSecret } from '../lib/secret-box.js';
import { isUuid } from '../lib/uuid.js';
import { withoutSecret } from '../lib/whatsapp/graph.js';
import { requireAgent } from './require-agent.js';

/** How much of the log the screen reads. Older than fifty is history, not a fault report. */
const LOG_LIMIT = 50;

/**
 * The test code the verification event carries when the owner has not given one.
 *
 * It is not optional. Meta counts an event with no `test_event_code` as a real conversion,
 * so verifying the settings would teach the optimiser about a sale that never happened —
 * every time anyone pressed «Сохранить». Any non-empty code routes the event to the test
 * console instead and keeps it out of optimisation, which is the whole requirement here;
 * an owner who gave their own code gets it back in Events Manager, and one who did not
 * simply never sees this event.
 */
const VERIFY_TEST_CODE = 'RAKURS_VERIFY';

/** A number nobody has. It is hashed before it leaves, and it is here only for the shape. */
const VERIFY_PHONE = '00000000000';

const settingsBody = z.object({
  datasetId: z.string().trim().min(1).max(64),
  // Optional, and that is not laziness: an owner flipping the switch or clearing the test
  // code must not have to fetch a system user token out of Meta again. Absent means «the
  // one already stored», which is then what gets verified — so a saved row is never marked
  // proved against a pair nobody checked.
  accessToken: z.string().trim().min(1).optional(),
  testEventCode: z.string().trim().min(1).nullable().optional(),
  enabled: z.boolean().optional(),
});

/** The card an agent that has never configured this is answered. */
const BLANK: CapiSettings = {
  datasetId: '',
  testEventCode: null,
  enabled: false,
  tokenSet: false,
  verifiedAt: null,
  error: null,
};

/** The access token is never part of this. Only that there is one. */
const toApi = (row: typeof capiSettings.$inferSelect): CapiSettings => ({
  datasetId: row.datasetId,
  testEventCode: row.testEventCode,
  enabled: row.enabled,
  tokenSet: row.accessToken !== '',
  verifiedAt: row.verifiedAt?.toISOString() ?? null,
  error: row.error,
});

/**
 * The event sent to prove the dataset and the token.
 *
 * A `Lead` and not a `Purchase`, because a purchase carries an amount and there is no
 * amount here to carry. Its `event_id` is fresh on every save: Meta deduplicates on that id,
 * so a fixed one would make the second verification a no-op that Meta accepts without
 * looking — and a save would then report «проверено» about a token it never presented.
 *
 * The click and the phone are invented and match nobody. That is fine and is the point: the
 * event is marked as a test, so it is never attributed to anything and never counted. The
 * WhatsApp Business Account is the agent's own: Meta refuses a business-messaging event
 * without one, so a verification without it would prove nothing about real events.
 */
const verificationEvent = (wabaId: string) =>
  serialiseEvent(
    buildLead({
      conversationId: `verify-${randomUUID()}`,
      wabaId,
      ctwaClid: `verify.${randomUUID()}`,
      phone: VERIFY_PHONE,
      occurredAt: new Date(),
    }),
  );

/**
 * Refused before Meta is asked: without a WhatsApp Business Account there is nothing to put
 * in `whatsapp_business_account_id`, and no event this cabinet builds would be accepted.
 */
const NO_WABA_NUMBER =
  'Сначала подключите номер WhatsApp через Cloud API. Meta принимает покупки из переписки ' +
  'только от номеров с аккаунтом WhatsApp Business, а номер, подключённый по QR, его не имеет.';

/** The agent's WhatsApp Business Account to verify against, oldest Cloud API number first. */
async function agentWabaId(db: Db, agentId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ wabaId: whatsappNumbers.wabaId })
    .from(whatsappNumbers)
    .where(and(eq(whatsappNumbers.agentId, agentId), isNotNull(whatsappNumbers.wabaId)))
    .orderBy(asc(whatsappNumbers.createdAt))
    .limit(1);

  return row?.wabaId ?? undefined;
}

/**
 * What to tell an owner Meta said, with the token taken back out of it.
 *
 * Meta echoes a rejected credential inside its own error text, and this string is rendered
 * on the screen of whoever pressed the button. The client redacts what it produces; this is
 * the second gate, against the token this request is holding.
 */
function refusalText(error: CapiError, token: string): string {
  const text = error.detail ? `${error.message} Ответ Meta: ${error.detail}` : error.message;

  return withoutSecret(text, token);
}

/**
 * The log, joined to the things that make a row readable by a person.
 *
 * The amount comes from the order rather than from the payload. The payload is the exact
 * bytes sent to Meta and is never parsed anywhere on this path — parsing it to show an
 * amount would put the one number that must not pass through a float through one. Both
 * joins are left joins: an order or a conversation deleted since does not erase the fact
 * that the sale was reported.
 */
async function readEvents(db: Db, where: SQL | undefined, limit: number): Promise<CapiEvent[]> {
  const rows = await db
    .select({
      id: capiEvents.id,
      conversationId: capiEvents.conversationId,
      kind: capiEvents.kind,
      status: capiEvents.status,
      attempts: capiEvents.attempts,
      // Read to be compared, never to be shown or parsed. It is the same test the resend
      // route makes, so the screen and the route cannot disagree about which rows have
      // anything to send — and a plain string comparison is not a `JSON.parse`, so the
      // amount inside is still the digits the column holds.
      payload: capiEvents.payload,
      error: capiEvents.error,
      sentAt: capiEvents.sentAt,
      createdAt: capiEvents.createdAt,
      value: orders.amount,
      currency: orders.currency,
      contactName: contacts.name,
      contactPhone: contacts.phone,
    })
    .from(capiEvents)
    .leftJoin(orders, eq(orders.id, capiEvents.orderId))
    .leftJoin(conversations, eq(conversations.id, capiEvents.conversationId))
    .leftJoin(contacts, eq(contacts.id, conversations.contactId))
    .where(where)
    // Newest first: the report an owner came to look at is the one that just failed. The id
    // breaks a tie, so two events queued in the same instant have a stable order.
    .orderBy(desc(capiEvents.createdAt), desc(capiEvents.id))
    .limit(limit);

  return rows.map((row) => ({
    id: row.id,
    conversationId: row.conversationId,
    kind: row.kind,
    status: row.status,
    attempts: row.attempts,
    resendable: row.payload !== UNREPORTABLE_BODY,
    error: row.error,
    sentAt: row.sentAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    value: row.value,
    currency: row.currency,
    contactName: row.contactName,
    contactPhone: row.contactPhone,
  }));
}

export function registerCapiRoutes(
  app: FastifyInstance,
  db: Db,
  env: Env,
  guard: preHandlerHookHandler,
  capi: CapiClient,
): void {
  const anyMember = requireAgent(db);
  const ownerOnly = requireAgent(db, { role: 'owner' });

  const stored = async (agentId: string) => {
    const [row] = await db.select().from(capiSettings).where(eq(capiSettings.agentId, agentId));
    return row;
  };

  app.get(
    '/api/agents/:agentId/capi',
    // Any member: the operator who watches a report fail has to see whether the dataset is
    // configured at all. There is nothing secret in the answer.
    { preHandler: [guard, anyMember] },
    async (req): Promise<CapiSettings> => {
      const row = await stored(req.agent!.id);
      return row ? toApi(row) : { ...BLANK };
    },
  );

  app.put(
    '/api/agents/:agentId/capi',
    // Owner only: this is the business's dataset and a system user's token.
    { preHandler: [guard, ownerOnly] },
    async (req): Promise<CapiSettings> => {
      const parsed = settingsBody.safeParse(req.body);
      if (!parsed.success) throw new ApiError(400, 'Укажите идентификатор набора данных');
      const { datasetId, accessToken, testEventCode = null, enabled } = parsed.data;

      const agentId = req.agent!.id;
      const current = await stored(agentId);
      const now = new Date();

      /**
       * A request that only switches sending off proves nothing, and must not have to.
       *
       * Verification exists to stop a typo being saved as a working pair. Turning sending
       * off saves no pair — it stops one being used — and an owner whose token has just been
       * revoked is exactly the owner who most needs the switch: without this, their only way
       * to stop the queue is to delete the whole dataset, which also takes the log's
       * explanation with it. Anything else still goes to Meta first: a new token, a
       * different dataset id, or turning sending back on.
       */
      const onlyDisabling =
        enabled === false &&
        current !== undefined &&
        accessToken === undefined &&
        datasetId === current.datasetId;

      // What will be written: the stored token untouched when nothing is being proved, and
      // the proof's own timestamp and cleared error when something is.
      let sealed: string;
      let verifiedAt: Date | null;
      let error: string | null;

      if (onlyDisabling) {
        // Not even decrypted. A credentials key that no longer opens the row would otherwise
        // fail this request with «введите токен заново» — and block the switch as surely as
        // a revoked token would.
        sealed = current.accessToken;
        verifiedAt = current.verifiedAt;
        // Nothing was proved, so whatever Meta last said still stands.
        error = current.error;
      } else {
        // The token to prove and to store: the new one, or the one already sealed on the
        // row. Decryption failing here is a credentials key that no longer matches the row —
        // the owner's way out is to paste the token again, so that is what they are told.
        let token: string;
        if (accessToken !== undefined) {
          token = accessToken;
        } else if (!current) {
          throw new ApiError(400, 'Укажите токен доступа');
        } else {
          try {
            token = decryptSecret(current.accessToken, credentialsKey(env), tokenAad(agentId));
          } catch {
            throw new ApiError(400, 'Не удалось прочитать сохранённый токен. Введите его заново.');
          }
        }

        const wabaId = await agentWabaId(db, agentId);
        if (wabaId === undefined) throw new ApiError(400, NO_WABA_NUMBER);

        // Proved before anything is written. A dataset id with a typo is accepted in silence
        // by every part of this system except Meta, and the owner finds out weeks later when
        // they wonder why their ads got worse. A mistyped replacement must also leave the
        // working pair in place rather than overwrite it with one Meta will refuse.
        try {
          await capi.send({
            datasetId,
            token,
            testEventCode: testEventCode ?? VERIFY_TEST_CODE,
            events: [verificationEvent(wabaId)],
          });
        } catch (thrown) {
          if (!(thrown instanceof CapiError)) throw thrown;
          const text = refusalText(thrown, token);

          // Written down, not merely announced. A toast is gone on the next reload, and the
          // card's red line is where an owner looks for why their dataset is not working —
          // the contract's `error`, the screen's block and the spec's promise all depend on
          // this one write. Only onto a row that already exists: a pair Meta refused is
          // never stored, so a first save has no row to carry the reason and the toast is
          // all there is.
          if (current) {
            await db
              .update(capiSettings)
              .set({ error: text, updatedAt: now })
              .where(eq(capiSettings.agentId, agentId));
          }

          // 502 whatever Meta answered: from the cabinet's side this is an upstream refusal,
          // and the owner's request was well formed — it is the pair that is wrong, and the
          // message is what says so.
          throw new ApiError(502, text);
        }

        // Sealed to the agent's id, which is what `sendPendingCapiEvents` opens it with: a
        // row copied onto another agent decrypts to nothing rather than to a working token.
        sealed = encryptSecret(token, credentialsKey(env), tokenAad(agentId));
        verifiedAt = now;
        // Whatever Meta refused last time, it has just accepted this pair.
        error = null;
      }

      // Absent leaves the switch as the owner last set it, and turns a brand-new dataset on:
      // a pair Meta has just accepted, saved on a screen with a switch, is not meant to sit
      // there reporting nothing.
      const on = enabled ?? current?.enabled ?? true;

      const [row] = await db
        .insert(capiSettings)
        .values({
          agentId,
          datasetId,
          accessToken: sealed,
          testEventCode,
          enabled: on,
          verifiedAt,
          error,
        })
        .onConflictDoUpdate({
          target: capiSettings.agentId,
          set: {
            datasetId,
            accessToken: sealed,
            testEventCode,
            enabled: on,
            verifiedAt,
            error,
            updatedAt: now,
          },
        })
        .returning();

      return toApi(row!);
    },
  );

  app.delete(
    '/api/agents/:agentId/capi',
    { preHandler: [guard, ownerOnly] },
    async (req): Promise<{ ok: true }> => {
      const [row] = await db
        .delete(capiSettings)
        .where(eq(capiSettings.agentId, req.agent!.id))
        .returning({ agentId: capiSettings.agentId });

      if (!row) throw new ApiError(404, 'Отправка в Meta не настроена');
      // The events already queued are left alone. The drain reads the settings on every
      // pass and writes «Meta Conversions API не настроен» onto them, which is the answer
      // an owner needs — deleting them here would take the explanation away with them.
      return { ok: true };
    },
  );

  app.get(
    '/api/agents/:agentId/capi/events',
    // Any member: the operator watching a lead is the one who notices a report failed.
    { preHandler: [guard, anyMember] },
    async (req): Promise<CapiEvent[]> => {
      const agentId = req.agent!.id;
      const { conversationId } = req.query as { conversationId?: string };

      // Narrowed to one conversation for the lead card, which asks about the thread it is
      // open on. Filtered here rather than in the browser: the full log stops at fifty rows,
      // so a lead whose sale was reported a month ago would read as never reported at all.
      // A malformed identifier answers with nothing rather than raising — comparing
      // non-uuid text against a uuid column makes Postgres throw.
      if (conversationId !== undefined) {
        if (!isUuid(conversationId)) return [];
        return readEvents(
          db,
          and(eq(capiEvents.agentId, agentId), eq(capiEvents.conversationId, conversationId)),
          LOG_LIMIT,
        );
      }

      return readEvents(db, eq(capiEvents.agentId, agentId), LOG_LIMIT);
    },
  );

  app.post(
    // `:eventId` here is the log row's id, not Meta's `event_id` — that one is derived from
    // what is reported and is exactly what a resend must not change.
    '/api/agents/:agentId/capi/events/:eventId/resend',
    // Any member, by design: this is the one action on this screen an operator needs, and
    // it costs nothing to press twice. Meta counts one conversion per `event_id`.
    { preHandler: [guard, anyMember] },
    async (req): Promise<CapiEvent> => {
      const { eventId } = req.params as { eventId: string };
      // Comparing non-UUID text against a uuid column makes Postgres raise, which would
      // turn a typo into a 500.
      if (!isUuid(eventId)) throw new ApiError(404, 'Событие не найдено');

      // The agent condition is what stops one account resending another's event even when
      // the identifier is guessed.
      const owned = and(eq(capiEvents.id, eventId), eq(capiEvents.agentId, req.agent!.id));

      const [current] = await db.select().from(capiEvents).where(owned);
      if (!current) throw new ApiError(404, 'Событие не найдено');

      // The one row a resend must refuse. A conversation that did not come from an ad has
      // no `ctwa_clid`, so no event could be built and the payload is the empty object; the
      // click is captured once, on the first message, and cannot be recovered afterwards.
      // Flipped to `pending` this row would be claimed by the drain and posted to Meta as
      // an empty body — a request the owner would then read as a Meta failure. Refused
      // here rather than on the screen: the screen can only hide the button.
      if (current.payload === UNREPORTABLE_BODY) {
        throw new ApiError(
          409,
          'Это событие нельзя отправить: диалог начался не с рекламы, у него нет ctwa_clid, ' +
            'и Meta не с чем сопоставить покупку.',
        );
      }

      await db
        .update(capiEvents)
        .set({
          status: 'pending',
          attempts: 0,
          // Cleared with the attempts, and this is not cosmetic: the drain's widening gap is
          // measured from the last attempt, so a row that has just spent its fifth attempt
          // would wait another two hours after an owner pressed the button.
          lastAttemptAt: null,
          error: null,
          // Both describe a send that is being made again. A `sent_at` left in place would
          // say the event has gone while its status says it has not, and the trace id
          // referred to an exchange Meta has since forgotten.
          sentAt: null,
          fbtraceId: null,
        })
        .where(owned);

      const [row] = await readEvents(db, eq(capiEvents.id, eventId), 1);
      return row!;
    },
  );
}
