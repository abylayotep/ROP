import { and, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import {
  capiEvents,
  capiSettings,
  contacts,
  conversations,
  orders,
  stages,
} from '../../db/schema.js';
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
 * Two of them are exported because the queue writes the same two: the dataset can be turned
 * off between the sale and the pass that reports it, and an owner reading the log must not
 * have to work out that «отключена в интеграциях» and some second wording for the same
 * condition mean the same thing.
 */
export const NO_SETTINGS =
  'Не отправлено: Meta Conversions API не настроен. Укажите набор данных в интеграциях.';
export const DISABLED = 'Не отправлено: отправка в Meta отключена в интеграциях.';
const NO_CLID =
  'Не отправлено: диалог начался не с рекламы, у него нет ctwa_clid, ' +
  'и Meta не с чем его сопоставить.';

/**
 * Why this event cannot go, or null when it can.
 *
 * The dataset is checked before the click: an agent that has never configured Meta is told
 * that, rather than being told about an identifier they have not yet been asked for.
 */
async function skipReason(
  db: Db,
  agentId: string,
  ctwaClid: string | null,
): Promise<string | null> {
  const [settings] = await db
    .select({ enabled: capiSettings.enabled })
    .from(capiSettings)
    .where(eq(capiSettings.agentId, agentId));

  if (!settings) return NO_SETTINGS;
  if (!settings.enabled) return DISABLED;
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
      .select({ order: orders, conversation: conversations, contact: contacts })
      .from(orders)
      .innerJoin(conversations, eq(conversations.id, orders.conversationId))
      .innerJoin(contacts, eq(contacts.id, conversations.contactId))
      .where(and(eq(orders.id, input.orderId), eq(orders.agentId, input.agentId)));
    if (!row) return;

    // Re-read rather than trusted: the caller reports a transition it saw, and an order
    // that is no longer paid by the time this runs has nothing to report. That is not a
    // skip — nothing was refused — so it leaves no row.
    if (row.order.status !== 'paid' || row.order.paidAt === null) return;

    const eventId = purchaseEventId(row.order.id);
    if (await alreadyQueued(db, eventId)) return;

    const ctwaClid = row.conversation.ctwaClid;
    const reason = await skipReason(db, input.agentId, ctwaClid);

    await insertEvent(db, {
      agentId: input.agentId,
      conversationId: row.conversation.id,
      orderId: row.order.id,
      kind: 'purchase',
      eventId,
      payload:
        ctwaClid === null
          ? UNREPORTABLE_BODY
          : serialiseEvent(
              buildPurchase({
                orderId: row.order.id,
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
  input: { agentId: string; conversationId: string },
): Promise<void> {
  try {
    const [row] = await db
      .select({ conversation: conversations, contact: contacts, stage: stages })
      .from(conversations)
      .innerJoin(contacts, eq(contacts.id, conversations.contactId))
      .innerJoin(stages, eq(stages.id, conversations.stageId))
      .where(
        and(
          eq(conversations.id, input.conversationId),
          eq(conversations.agentId, input.agentId),
        ),
      );
    if (!row || row.stage.kind !== 'qualified') return;

    const eventId = leadEventId(row.conversation.id);
    if (await alreadyQueued(db, eventId)) return;

    const ctwaClid = row.conversation.ctwaClid;
    const reason = await skipReason(db, input.agentId, ctwaClid);

    await insertEvent(db, {
      agentId: input.agentId,
      conversationId: row.conversation.id,
      orderId: null,
      kind: 'lead',
      eventId,
      payload:
        ctwaClid === null
          ? UNREPORTABLE_BODY
          : serialiseEvent(
              buildLead({
                conversationId: row.conversation.id,
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
  } catch {
    // The stage move is what the operator — or the agent — asked for, and it has already
    // happened. See `queuePurchase`.
  }
}
