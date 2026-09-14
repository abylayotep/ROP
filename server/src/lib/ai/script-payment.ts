/**
 * The reply a payment starts: the customer paid, wrote nothing, and the script says what comes
 * after payment — «после оплаты отправь фото готовой печати».
 *
 * ## Why a sweep, not a hook in the two places payment is recognised
 *
 * Money becomes a paid order in two places — the CRM worker's chat order and Kaspi's
 * reconciliation, which itself runs from a timer and from an operator's «проверить статус» —
 * and neither has the transports a turn needs. A hook in each would be three call sites, each
 * one a commit away from a crash that loses the turn. So this reads the outcome instead: a paid
 * order, newer than the conversation's current sale, on a conversation still standing on a
 * «ждать оплату» step, that no turn has acted on. Whatever path made the order paid, and whether
 * or not the process died a moment later, the next pass finds it.
 *
 * ## Why it cannot send twice
 *
 * `orders.script_payment_turn_at` is claimed with a conditional update before the turn runs, and
 * a customer's own turn that saw the payment claims it too (see `runTurn`). One claim per order,
 * so a payment recognised twice — Kaspi and the chat both, or two passes racing — starts at most
 * one turn. A claim is never released: a turn that fails after it leaves the conversation on the
 * payment step, to be moved by the customer's next message, which is a delay; releasing it is
 * the window in which two turns could answer the same payment.
 *
 * ## The gates
 *
 * Every gate a live reply has, because `runTurn` runs them all: automation, both switches, the
 * test contact, the operator's number, the reply window, the thread moving under the model. On
 * top, two of its own. A conversation whose customer wrote in the last few minutes is left to
 * that message's turn, unclaimed, since that turn is already answering with the payment in view.
 * And a payment the agent may not act on right now — automation off, an operator on the thread —
 * is claimed and dropped, so switching the agent back on hours later does not suddenly thank a
 * customer for yesterday's money.
 */
import { and, desc, eq, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { conversations, messages, orders, salesScriptSteps } from '../../db/schema.js';
import { decideAutomation, loadAutomationSnapshot } from '../automation/policy.js';
import { runTurn, type TurnDeps, type TurnResult } from './turn.js';

/** How far back a payment may start a turn. Older than this, a thank-you reads as a mistake. */
const LOOKBACK = '6 hours';
/** A customer message this recent is being answered by its own turn. */
const CUSTOMER_TURN_MS = 10 * 60_000;
/** How many payments one pass takes; the rest wait for the next pass. */
const BATCH = 10;

export interface PaymentTurn {
  orderId: string;
  conversationId: string;
  /** Null when the payment was claimed without a turn, or left for a customer's turn. */
  result: TurnResult | null;
  claimed: boolean;
}

export async function runScriptPaymentTurns(db: Db, deps: TurnDeps): Promise<PaymentTurn[]> {
  const at = sql`greatest(${orders.paidAt}, ${orders.createdAt})`;
  const candidates = await db
    .select({ orderId: orders.id, conversationId: conversations.id, agentId: conversations.agentId })
    .from(orders)
    .innerJoin(conversations, and(eq(conversations.id, orders.conversationId), eq(conversations.agentId, orders.agentId)))
    .innerJoin(salesScriptSteps, and(eq(salesScriptSteps.id, conversations.scriptStepId),
      eq(salesScriptSteps.agentId, conversations.agentId), eq(salesScriptSteps.waitPayment, true)))
    .where(and(
      eq(orders.status, 'paid'),
      isNull(orders.scriptPaymentTurnAt),
      isNotNull(conversations.scriptStartedAt),
      sql`${at} >= ${conversations.scriptStartedAt}`,
      sql`${at} > now() - ${LOOKBACK}::interval`,
    ))
    .orderBy(at)
    .limit(BATCH);

  const done: PaymentTurn[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    // One turn per conversation per pass: a second paid order of the same sale is the same news.
    if (seen.has(candidate.conversationId)) continue;
    seen.add(candidate.conversationId);
    done.push(await handle(db, deps, candidate));
  }
  return done;
}

async function claim(db: Db, orderId: string): Promise<boolean> {
  const rows = await db.update(orders).set({ scriptPaymentTurnAt: new Date() })
    .where(and(eq(orders.id, orderId), isNull(orders.scriptPaymentTurnAt)))
    .returning({ id: orders.id });
  return rows.length > 0;
}

async function handle(
  db: Db,
  deps: TurnDeps,
  candidate: { orderId: string; conversationId: string; agentId: string },
): Promise<PaymentTurn> {
  const { orderId, conversationId, agentId } = candidate;
  const [newest] = await db.select({ author: messages.author, sentAt: messages.sentAt }).from(messages)
    .where(and(eq(messages.conversationId, conversationId), ne(messages.author, 'system')))
    .orderBy(desc(messages.sentAt), desc(messages.createdAt)).limit(1);
  if (newest?.author === 'client' && Date.now() - newest.sentAt.getTime() < CUSTOMER_TURN_MS) {
    return { orderId, conversationId, result: null, claimed: false };
  }

  const snapshot = await loadAutomationSnapshot(db, { agentId, conversationId });
  const allowed = snapshot !== null && decideAutomation(snapshot, 'reply').allowed;
  const personOnThread = newest?.author === 'operator' || newest?.author === 'phone';
  if (!allowed || personOnThread) {
    return { orderId, conversationId, result: null, claimed: await claim(db, orderId) };
  }

  if (!await claim(db, orderId)) return { orderId, conversationId, result: null, claimed: false };
  const result = await runTurn(db, deps, { agentId, conversationId, paidOrderId: orderId });
  return { orderId, conversationId, result, claimed: true };
}
