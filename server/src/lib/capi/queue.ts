import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { capiEvents, capiSettings, contacts, conversations, orders } from '../../db/schema.js';
import { decryptSecret } from '../secret-box.js';
import { withoutSecret } from '../whatsapp/graph.js';
import { CapiError, type CapiClient } from './client.js';
import { DISABLED, NO_CLID, NO_SETTINGS } from './enqueue.js';
import { buildPurchase, serialiseEvent, type CapiEventBody } from './events.js';

/**
 * Draining the queue: telling Meta what the cabinet already knows.
 *
 * A function over pending rows rather than code on the path that queued them, for the same
 * three reasons `processPendingEvents` is one: the operator who marked an order paid is not
 * kept waiting on Meta, the tests can drive it without HTTP, and an event that failed for a
 * reason an owner has since fixed can be run again.
 *
 * It follows that queue deliberately — the claim with `for update skip locked`, the attempt
 * counted before the work, the reason written onto the row. Two queues in one codebase that
 * behave differently is how one of them ends up wrong.
 */

export interface CapiQueueDeps {
  capi: CapiClient;
  /** The credentials key. Each dataset's token is sealed to its agent's id. */
  key: Buffer;
}

/**
 * The associated data the dataset's token is sealed with.
 *
 * Declared next to the code that opens the token, and imported by the route that writes it,
 * exactly as `keyAad` in `lib/ai/turn.ts` is declared beside `runTurn` and imported by
 * `api/ai.ts`. Two files agreeing on a value by both writing `agentId` is an agreement that
 * holds only until one of them is edited; a token sealed under one aad and opened under
 * another does not fail loudly, it fails as «Meta не приняла токен» weeks later.
 */
export const tokenAad = (agentId: string): string => agentId;

export interface CapiDrainResult {
  /** Events Meta accepted in this pass. */
  sent: number;
  /** Events whose send did not land, whether they stay pending or are now out of attempts. */
  failed: number;
  /** Events that can no longer be sent at all, because the dataset was turned off or removed. */
  skipped: number;
}

/** The same cap the WhatsApp queue uses. Five is generous for a transient fault. */
const MAX_ATTEMPTS = 5;

/** How many events one agent takes per pass. Meta accepts an array; five sales are one request. */
const BATCH = 50;

/** How many agents one pass serves. With the budget below, this bounds the work of one drain. */
const AGENTS = 25;

/**
 * How long one drain may spend before it leaves the rest to the next pass.
 *
 * This runs behind a webhook response, and webhooks arrive continuously on a busy number: a
 * drain that worked through every agent while Meta answered slowly would still be running
 * when the next one started, and the passes would pile up on each other. The budget is
 * checked before each agent's batch is claimed, never in the middle of one, so nothing is
 * claimed and then abandoned — an abandoned claim would have spent an attempt on a send that
 * never happened.
 */
const MAX_DRAIN_MS = 20_000;

/**
 * When an event may be attempted again: a widening gap, measured from the last attempt.
 *
 * The gaps are 1, 5, 25 and 125 minutes — about two and a half hours from the first attempt
 * to the fifth. Long enough for a Meta incident to end, short enough that a sale is reported
 * the same day it was paid.
 *
 * From `last_attempt_at` and not from `created_at`, which is what the first version of this
 * did. A resend by hand (task 5) resets `attempts` on a row that may be days old, and a gap
 * measured from creation has long since elapsed — so the resend's remaining attempts would
 * all be spent within seconds of each other, which is not a retry budget at all. A rule the
 * next caller can defeat by touching a column that has nothing to do with it is not a rule.
 * `coalesce` covers the row that has never been attempted, whose gap is zero anyway.
 *
 * It is also what keeps two passes off one row once the claim's lock is gone. The claim
 * stamps `last_attempt_at` and increments `attempts` before any sending starts, exactly as
 * the WhatsApp pass stamps `processed_at` before the agent's turn: the stamp moves the row
 * out of this window, so a pass that arrives while Meta is thinking finds nothing to take.
 * That is the whole reason the attempt is counted first rather than after the answer.
 */
const READY = sql`
  status = 'pending'
  and attempts < ${MAX_ATTEMPTS}
  and coalesce(last_attempt_at, created_at) + (case attempts
        when 0 then interval '0 minutes'
        when 1 then interval '1 minute'
        when 2 then interval '5 minutes'
        when 3 then interval '25 minutes'
        else interval '125 minutes'
      end) <= now()
`;

/**
 * Why a purchase that was queued can no longer be reported, discovered at claim time.
 *
 * Written by the drain and by nothing else: every one of these describes something that
 * happened between the operator marking the order paid and this pass getting to it. They are
 * read by an owner on the integrations screen, so they are in the owner's language.
 */
const ORDER_GONE = 'Не отправлено: заказ удалён, отправлять уже нечего.';
const NOT_PAID =
  'Не отправлено: заказ больше не отмечен оплаченным — оплату отменили или изменили статус.';
const UNBUILDABLE =
  'Не отправлено: не удалось собрать событие по текущему заказу. Проверьте сумму заказа.';

/**
 * What is written onto a row that was claimed for a send that never reported back.
 *
 * `claim` counts the attempt before the send, so a process that dies between the two leaves
 * the row pending with the attempt already spent. Five of those and the row matches no ready
 * clause: nothing will claim it again, nothing will ever mark it failed, and it sits on the
 * screen as «В очереди» — which the screen documents as «не ошибка» — with no resend button,
 * because pending rows do not get one. The sale is then lost in silence, which is the one
 * outcome this whole queue exists to prevent.
 */
const EXHAUSTED =
  'Попытки отправки закончились: событие так и не ушло в Meta. ' +
  'Нажмите «Отправить снова», когда причина устранена.';

/** A claimed event. Raw SQL, so the columns arrive under their database names. */
interface ClaimedEvent {
  id: string;
  kind: string;
  order_id: string | null;
  payload: CapiEventBody;
  attempts: number;
  created_at: Date;
}

/**
 * The rows out of a `db.execute` result.
 *
 * The driver decides the shape: postgres-js hands back the rows as an array, node-postgres
 * wraps them in an object. The same helper as in `whatsapp/inbound.ts`, for the same reason.
 */
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown }).rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

/**
 * What to write onto a row Meta refused.
 *
 * `message` is ours and Russian; `detail` is Meta's own text, which is the half an owner can
 * act on — «Invalid access token» is the whole answer to why nothing arrived. Everything goes
 * through `withoutSecret` against the token that was just decrypted: Meta echoes a rejected
 * credential back inside its error, the client redacts what it produces, and this is the last
 * gate before a column that is read on a screen.
 */
function reasonOf(error: unknown, token: string): string {
  const text =
    error instanceof CapiError
      ? error.detail
        ? `${error.message} Ответ Meta: ${error.detail}`
        : error.message
      : `Не удалось отправить событие: ${error instanceof Error ? error.message : String(error)}`;

  return withoutSecret(text, token);
}

/**
 * Everything still pending for an agent that can no longer send, with the reason an owner
 * reads on the integrations screen — the same sentences `enqueue.ts` writes when the dataset
 * was already off at queue time.
 *
 * Every pending row of the agent, not only the ones whose backoff has passed: none of them
 * is sendable, and leaving the rest to be discovered one gap at a time would show an owner a
 * queue that empties itself over hours for no reason.
 *
 * No attempt is spent on this. Nothing was refused; there is nothing to retry.
 */
async function skipAll(db: Db, agentId: string, reason: string): Promise<number> {
  const skipped = await db
    .update(capiEvents)
    .set({ status: 'skipped', error: reason })
    .where(and(eq(capiEvents.agentId, agentId), eq(capiEvents.status, 'pending')))
    .returning({ id: capiEvents.id });

  return skipped.length;
}

/**
 * Ends the events that were claimed and never answered for.
 *
 * A drain that is killed mid-send — a redeploy, an OOM, a lost database connection between
 * the claim and the outcome — leaves the row pending with its attempt already counted. That
 * is survivable four times; the fifth leaves a row that is pending, at the cap, and therefore
 * outside `READY` forever. Nothing claims it again, so nothing ever writes `failed` on it,
 * and the screen shows «В очереди» with no resend button on a sale that will never go.
 *
 * So the drain begins by looking for exactly that shape and marking it failed. `failed` is
 * the state the screen renders in red and offers a resend for, which is the whole point: the
 * owner sees the sale that stalled and can push it again.
 *
 * Meta's own last words are kept where there were any — a row that spent its fifth attempt
 * on a refusal is already written `failed` by `recordFailure`, so in practice these rows have
 * no error at all, and `coalesce` is what makes the rare exception keep the more useful text.
 */
async function failExhausted(db: Db): Promise<number> {
  const done = await db
    .update(capiEvents)
    .set({ status: 'failed', error: sql`coalesce(${capiEvents.error}, ${EXHAUSTED})` })
    .where(and(eq(capiEvents.status, 'pending'), gte(capiEvents.attempts, MAX_ATTEMPTS)))
    .returning({ id: capiEvents.id });

  return done.length;
}

/**
 * Takes this agent's next batch, and counts and dates the attempt in the same statement.
 *
 * `for update skip locked` keeps two claims that land in the same instant off each other's
 * rows; the stamp keeps the pass that arrives a moment later off them too, because it moves
 * the row into its backoff window. Counting the attempt here rather than after the answer is
 * what eventually retires an event Meta always refuses.
 */
async function claim(db: Db, agentId: string): Promise<ClaimedEvent[]> {
  const claimed = await db.execute(sql`
    update capi_events
       set attempts = attempts + 1, last_attempt_at = now()
     where id in (
       select id from capi_events
        where agent_id = ${agentId} and ${READY}
        order by created_at
        limit ${BATCH}
        for update skip locked
     )
    returning id, kind, order_id, payload, attempts, created_at
  `);

  // `returning` has no order of its own. Oldest first, so a batch reaches Meta in the order
  // the sales happened.
  return rowsOf<ClaimedEvent>(claimed).sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );
}

/** A claimed purchase, re-read: either the bytes to send now, or why it cannot go at all. */
type Rebuilt = { body: CapiEventBody } | { reason: string };

/**
 * Builds the purchase again from the order as it stands at this moment.
 *
 * The stored payload is a snapshot of the instant the operator pressed «оплачен», and the
 * minutes between that instant and this pass are precisely when the mistake gets corrected:
 * the order goes back to `cancelled`, or the amount gets its missing zero. Sending the
 * snapshot reports a sale that was undone, or the wrong money — and because `alreadyQueued`
 * refuses to queue the same order twice, nothing in the cabinet would ever send a corrected
 * one. Deleting and re-creating the order to force it mints a new `event_id`, and Meta then
 * counts the sale twice.
 *
 * Rebuilding here costs nothing and fixes both, because `event_id` is derived from the order
 * id and does not move: what goes to Meta is the same single conversion, told correctly.
 */
async function rebuildPurchase(
  db: Db,
  agentId: string,
  orderId: string | null,
): Promise<Rebuilt> {
  // Null exactly when the order has been deleted: the column is `on delete set null`, so the
  // report outlives the order it was about — but it can no longer be rebuilt from it.
  if (orderId === null) return { reason: ORDER_GONE };

  const [row] = await db
    .select({ order: orders, conversation: conversations, contact: contacts })
    .from(orders)
    .innerJoin(conversations, eq(conversations.id, orders.conversationId))
    .innerJoin(contacts, eq(contacts.id, conversations.contactId))
    .where(and(eq(orders.id, orderId), eq(orders.agentId, agentId)));

  if (!row) return { reason: ORDER_GONE };
  if (row.order.status !== 'paid' || row.order.paidAt === null) return { reason: NOT_PAID };

  const ctwaClid = row.conversation.ctwaClid;
  if (ctwaClid === null) return { reason: NO_CLID };

  try {
    return {
      body: serialiseEvent(
        buildPurchase({
          orderId: row.order.id,
          ctwaClid,
          phone: row.contact.phone,
          amount: row.order.amount,
          currency: row.order.currency,
          paidAt: row.order.paidAt,
        }),
      ),
    };
  } catch {
    // `buildPurchase` refuses an amount that is not a plain decimal. Waiting will not make it
    // one, so the event ends here rather than spending four more attempts on the same answer.
    return { reason: UNBUILDABLE };
  }
}

/**
 * Ends one claimed event without sending it, and gives back the attempt the claim spent.
 *
 * Nothing was refused and nothing was even offered to Meta, so charging the event an attempt
 * would be a lie told in a column an owner reads as «попыток: 1». `skipAll` spends none for
 * the same reason; this path only has to undo what `claim` did a moment earlier.
 */
async function skipOne(db: Db, id: string, reason: string): Promise<void> {
  await db
    .update(capiEvents)
    .set({
      status: 'skipped',
      error: reason,
      attempts: sql`greatest(${capiEvents.attempts} - 1, 0)`,
    })
    .where(eq(capiEvents.id, id));
}

/**
 * Re-reads what the claimed batch actually reports, and returns what is still worth sending.
 *
 * Only purchases are rebuilt. A lead is a milestone that cannot be undone: a conversation
 * legitimately walks on from the qualifying stage into `awaiting_payment` or `success`, so
 * asking «is it still qualified?» would drop exactly the leads that converted, and by then
 * `stage_set_at` names a later stage — a rebuilt `event_time` would be the wrong moment, not
 * a corrected one. Everything else a lead carries is write-once (`ctwa_clid`) or not editable
 * in the cabinet (the contact's phone), and a lead has no amount, which is the mutable half
 * of a purchase. There is nothing about a lead that a second read would tell us.
 */
async function refresh(
  db: Db,
  agentId: string,
  claimed: ClaimedEvent[],
): Promise<{ ready: ClaimedEvent[]; skipped: number }> {
  const ready: ClaimedEvent[] = [];
  let skipped = 0;

  for (const event of claimed) {
    if (event.kind !== 'purchase') {
      ready.push(event);
      continue;
    }

    const rebuilt = await rebuildPurchase(db, agentId, event.order_id);
    if ('reason' in rebuilt) {
      await skipOne(db, event.id, rebuilt.reason);
      skipped += 1;
      continue;
    }

    // Stored, so the log shows the bytes that were actually sent rather than the ones an
    // earlier version of the order produced. Written only when it changed, so an unchanged
    // batch is one statement lighter.
    if (rebuilt.body !== event.payload) {
      await db
        .update(capiEvents)
        .set({ payload: rebuilt.body })
        .where(eq(capiEvents.id, event.id));
    }

    ready.push({ ...event, payload: rebuilt.body });
  }

  return { ready, skipped };
}

/**
 * Records a refusal on the rows it was refused for.
 *
 * A `CapiError` that is not retryable ends the events immediately, whatever their attempt
 * count: an invalid token and a dataset that is not ours say the same thing on the fifth
 * attempt as on the first, and an owner reading «отправляется» about an event that will
 * never go is being lied to. Anything else — a throttle, a timeout, a socket, a key that no
 * longer opens the token — stays pending until the attempts run out, and the row that spent
 * its last attempt is written `failed` here rather than left pending forever with nothing
 * willing to claim it again.
 */
async function recordFailure(
  db: Db,
  claimed: ClaimedEvent[],
  error: unknown,
  token: string,
): Promise<void> {
  const permanent = error instanceof CapiError && !error.retryable;
  const reason = reasonOf(error, token);

  const done = claimed.filter((row) => permanent || row.attempts >= MAX_ATTEMPTS);
  const again = claimed.filter((row) => !permanent && row.attempts < MAX_ATTEMPTS);

  if (done.length > 0) {
    await db
      .update(capiEvents)
      .set({ status: 'failed', error: reason })
      .where(inArray(capiEvents.id, done.map((row) => row.id)));
  }
  if (again.length > 0) {
    await db
      .update(capiEvents)
      .set({ error: reason })
      .where(inArray(capiEvents.id, again.map((row) => row.id)));
  }
}

/**
 * One pass over everything waiting for Meta.
 *
 * One agent's refusal never costs the others theirs: the next entry in the list is somebody
 * else's sale, and a queue that stops at the first bad token reports nothing for anybody.
 */
export async function sendPendingCapiEvents(
  db: Db,
  deps: CapiQueueDeps,
): Promise<CapiDrainResult> {
  const deadline = Date.now() + MAX_DRAIN_MS;
  const result: CapiDrainResult = { sent: 0, failed: 0, skipped: 0 };

  // Before anything is claimed: a row left behind by a drain that died is invisible to every
  // query below it, so nothing else in this function would ever find it.
  result.failed += await failExhausted(db);

  // Agents first, batches second: Meta takes an array, so one agent with five sales is one
  // request. Oldest queue first, so a busy agent cannot keep a quiet one waiting forever.
  const waiting = rowsOf<{ agent_id: string }>(
    await db.execute(sql`
      select agent_id
        from capi_events
       where ${READY}
       group by agent_id
       order by min(created_at)
       limit ${AGENTS}
    `),
  );

  for (const { agent_id: agentId } of waiting) {
    if (Date.now() >= deadline) break;

    const [settings] = await db
      .select()
      .from(capiSettings)
      .where(eq(capiSettings.agentId, agentId));

    // Read now rather than at queue time, because an owner can turn the dataset off — or
    // delete it — between the sale and this pass. Sending anyway would report to a dataset
    // its owner has withdrawn.
    if (!settings || !settings.enabled) {
      result.skipped += await skipAll(db, agentId, settings ? DISABLED : NO_SETTINGS);
      continue;
    }

    const claimed = await claim(db, agentId);
    if (claimed.length === 0) continue;

    // Read again before sending: the order may have been cancelled or corrected since it was
    // queued, and the event id does not change, so what goes out is the same conversion.
    const { ready, skipped } = await refresh(db, agentId, claimed);
    result.skipped += skipped;
    if (ready.length === 0) continue;

    let token = '';
    try {
      // Decrypted inside the try, on purpose: a key that no longer matches — rotated, or a
      // row someone edited — must cost this agent's batch, not the whole pass. `withoutSecret`
      // with an empty secret returns the text unchanged, which is right: there is no token to
      // hide when decryption itself is what failed.
      token = decryptSecret(settings.accessToken, deps.key, tokenAad(agentId));

      // The payloads go out as `refresh` left them: rebuilt from the order for a purchase,
      // stored as they were for a lead. Either way they are bytes by now — nothing on this
      // path parses or re-serialises them, which is what keeps the order's amount the digits
      // the column holds.
      //
      // Meta's `fbtrace_id` is kept: it is the first thing their support asks for when a
      // report is missing from Events Manager, and by then the response is long gone. A
      // batch is one exchange, so every event of it carries the same id.
      const answer = await deps.capi.send({
        datasetId: settings.datasetId,
        token,
        testEventCode: settings.testEventCode,
        events: ready.map((row) => row.payload),
      });

      await db
        .update(capiEvents)
        .set({
          status: 'sent',
          sentAt: new Date(),
          error: null,
          fbtraceId: answer.fbtraceId,
        })
        .where(inArray(capiEvents.id, ready.map((row) => row.id)));
      result.sent += ready.length;
    } catch (error) {
      await recordFailure(db, ready, error, token);
      result.failed += ready.length;
    }
  }

  return result;
}
