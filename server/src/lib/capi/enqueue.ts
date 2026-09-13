import { and, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import {
  capiEvents,
  capiSettings,
  contacts,
  conversations,
  orders,
  stages,
  whatsappNumbers,
} from '../../db/schema.js';
import { withAgentAutomationLock } from '../automation/execution.js';
import {
  UNREPORTABLE_BODY,
  buildLead,
  buildPurchase,
  leadEventId,
  purchaseEventId,
  serialiseEvent,
  type CapiEventBody,
} from './events.js';

/**
 * The hooks: turning something that just happened in the cabinet into a row for Meta.
 *
 * Neither function throws. An operator who has recorded a payment must not read
 * «Внутренняя ошибка сервера» because a report could not be queued — the money is the fact
 * and the report is the consequence, and a consequence that fails must not undo its cause.
 * `sendStageMessage` in `server/src/lib/funnel-message.ts` is the same shape for the same
 * reason.
 *
 * What is skipped is written down rather than dropped. An owner asking «почему эта продажа
 * не ушла в Meta» deserves an answer, and a skipped row also takes its `event_id`, so the
 * only thing that can report it after the reason is fixed is a deliberate resend by hand.
 */

/**
 * The reasons an owner reads on the integrations screen, so they are in the owner's
 * language. Meta's own refusals arrive in English and are stored as Meta wrote them; these
 * are ours, and nobody at Meta reads them.
 *
 * Most of them are exported because the queue writes the same ones: the dataset can be
 * turned off — or removed, or the conversation's click id lost with the conversation —
 * between the sale and the pass that reports it, and an owner reading the log must not have
 * to work out that «отключена в интеграциях» and some second wording for the same condition
 * mean the same thing.
 */
export const NO_SETTINGS =
  'Не отправлено: Meta Conversions API не настроен. Укажите набор данных в интеграциях.';
export const DISABLED = 'Не отправлено: отправка в Meta отключена в интеграциях.';
export const NO_CLID =
  'Не отправлено: диалог начался не с рекламы, у него нет ctwa_clid, ' +
  'и Meta не с чем его сопоставить.';
export const NON_WHATSAPP =
  'Не отправлено: Meta Conversions API поддерживается только для диалогов WhatsApp.';
export const NO_WABA =
  'Не отправлено: номер подключён без аккаунта WhatsApp Business (например, по QR). ' +
  'Meta принимает покупки из переписки только от номеров на WhatsApp Cloud API.';

/**
 * Why this event cannot go, or null when it can.
 *
 * The dataset is checked before the click: an agent that has never configured Meta is told
 * that, rather than being told about an identifier they have not yet been asked for.
 */
async function skipReason(
  db: Db,
  agentId: string,
  wabaId: string | null,
  ctwaClid: string | null,
): Promise<string | null> {
  const [settings] = await db
    .select({ enabled: capiSettings.enabled })
    .from(capiSettings)
    .where(eq(capiSettings.agentId, agentId));

  if (!settings) return NO_SETTINGS;
  if (!settings.enabled) return DISABLED;
  if (wabaId === null) return NO_WABA;
  if (ctwaClid === null) return NO_CLID;
  return null;
}

/**
 * True when this fact has already been queued, whatever became of it.
 *
 * The unique index on `event_id` is what actually enforces "once" — this check only saves
 * the round trip of an insert that would conflict, and the insert below still says
 * `on conflict do nothing` so that two concurrent callers race into one row instead of one
 * row and one raised error.
 */
async function alreadyQueued(db: Db, eventId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: capiEvents.id })
    .from(capiEvents)
    .where(eq(capiEvents.eventId, eventId));

  return row !== undefined;
}

async function insertEvent(
  db: Db,
  row: {
    agentId: string;
    conversationId: string;
    orderId: string | null;
    kind: 'purchase' | 'lead';
    eventId: string;
    payload: CapiEventBody;
    reason: string | null;
  },
): Promise<void> {
  await db
    .insert(capiEvents)
    .values({
      agentId: row.agentId,
      conversationId: row.conversationId,
      orderId: row.orderId,
      kind: row.kind,
      eventId: row.eventId,
      payload: row.payload,
      status: row.reason === null ? 'pending' : 'skipped',
      error: row.reason,
    })
    .onConflictDoNothing({ target: capiEvents.eventId });
}

/**
 * Queues a `Purchase` for an order that has just become paid.
 *
 * Called only where an order's status changes to `paid` from something else, which is why
 * nothing here re-reads the previous status: this asks whether the order is reportable, not
 * whether it moved.
 */
export async function queuePurchase(
  db: Db,
  input: { agentId: string; orderId: string },
): Promise<void> {
  try {
    const [row] = await db
      .select({
        order: orders,
        conversation: conversations,
        contact: contacts,
        wabaId: whatsappNumbers.wabaId,
      })
      .from(orders)
      .innerJoin(conversations, eq(conversations.id, orders.conversationId))
      .innerJoin(contacts, eq(contacts.id, conversations.contactId))
      .leftJoin(whatsappNumbers, eq(whatsappNumbers.id, conversations.whatsappNumberId))
      .where(and(eq(orders.id, input.orderId), eq(orders.agentId, input.agentId)));
    if (!row) return;

    // Re-read rather than trusted: the caller reports a transition it saw, and an order
    // that is no longer paid by the time this runs has nothing to report. That is not a
    // skip — nothing was refused — so it leaves no row.
    if (row.order.status !== 'paid' || row.order.paidAt === null) return;

    const eventId = purchaseEventId(row.order.id);
    if (await alreadyQueued(db, eventId)) return;

    const ctwaClid = row.conversation.ctwaClid;
    const wabaId = row.wabaId;
    const reason = row.conversation.whatsappNumberId === null
      ? NON_WHATSAPP
      : await skipReason(db, input.agentId, wabaId, ctwaClid);

    await insertEvent(db, {
      agentId: input.agentId,
      conversationId: row.conversation.id,
      orderId: row.order.id,
      kind: 'purchase',
      eventId,
      payload:
        wabaId === null || ctwaClid === null || row.contact.phone === null
          ? UNREPORTABLE_BODY
          : serialiseEvent(
              buildPurchase({
                orderId: row.order.id,
                wabaId,
                ctwaClid,
                phone: row.contact.phone,
                amount: row.order.amount,
                currency: row.order.currency,
                paidAt: row.order.paidAt,
              }),
            ),
      reason,
    });
  } catch {
    // The operator recorded a payment and that is what they asked for. There is nowhere left
    // to write why the report was not queued, and raising here would turn a recorded sale
    // into a 500 in the face of the person who recorded it.
  }
}

/**
 * Queues a `Lead` for a conversation that has just entered a qualifying stage.
 *
 * Takes no stage: it reads the stage the conversation is in now, which is the one the caller
 * has just written. A move to any other kind of stage is not a lead event and leaves nothing
 * behind — only `qualified` is reported, because that is the one kind that means the same
 * thing in every funnel an owner reshapes.
 */
export async function queueLead(
  db: Db,
  input: {
    agentId: string;
    conversationId: string;
    canQueue?: (db: Db) => Promise<boolean>;
  },
): Promise<void> {
  try {
    const queue = async (effectDb: Db) => {
      const [row] = await effectDb
        .select({
          conversation: conversations,
          contact: contacts,
          stage: stages,
          wabaId: whatsappNumbers.wabaId,
        })
        .from(conversations)
        .innerJoin(contacts, eq(contacts.id, conversations.contactId))
        .innerJoin(stages, eq(stages.id, conversations.stageId))
        .leftJoin(whatsappNumbers, eq(whatsappNumbers.id, conversations.whatsappNumberId))
        .where(
          and(
            eq(conversations.id, input.conversationId),
            eq(conversations.agentId, input.agentId),
          ),
        );
      if (!row || row.stage.kind !== 'qualified') return;

      const eventId = leadEventId(row.conversation.id);
      if (await alreadyQueued(effectDb, eventId)) return;

      const ctwaClid = row.conversation.ctwaClid;
      const wabaId = row.wabaId;
      const reason = row.conversation.whatsappNumberId === null
        ? NON_WHATSAPP
        : await skipReason(effectDb, input.agentId, wabaId, ctwaClid);
      await insertEvent(effectDb, {
        agentId: input.agentId,
        conversationId: row.conversation.id,
        orderId: null,
        kind: 'lead',
        eventId,
        payload:
          wabaId === null || ctwaClid === null || row.contact.phone === null
            ? UNREPORTABLE_BODY
            : serialiseEvent(
                buildLead({
                  conversationId: row.conversation.id,
                  wabaId,
                  ctwaClid,
                  phone: row.contact.phone,
                  // When the lead got there, not when we got round to reporting it. The column
                  // is written in the same statement that moved the stage; the `??` covers a
                  // row from before that column existed.
                  occurredAt: row.conversation.stageSetAt ?? new Date(),
                }),
              ),
        reason,
      });
    };

    if (input.canQueue) {
      await withAgentAutomationLock(db, input.agentId, async (tx) => {
        const effectDb = tx as unknown as Db;
        if (!await input.canQueue!(effectDb)) return;
        await queue(effectDb);
      });
    } else {
      await queue(db);
    }
  } catch {
    // The stage move is what the operator — or the agent — asked for, and it has already
    // happened. See `queuePurchase`.
  }
}
