import { createHash } from 'node:crypto';

/**
 * Turning a fact the cabinet already holds into the object Meta receives.
 *
 * Pure on purpose: no `Db`, no fetch, no clock. It takes the values a caller has already
 * read and returns what will be stored in `capi_events.payload` and sent verbatim. That is
 * what lets the queue store an event now and send it later without asking whether the rows
 * it was built from have changed since.
 */

/**
 * Meta's Conversions API for Business Messaging. `action_source` and `messaging_channel`
 * are what tell it this conversion happened in a chat rather than on a website — the pair
 * is also what makes `ctwa_clid` an acceptable identifier.
 */
const ACTION_SOURCE = 'business_messaging' as const;
const MESSAGING_CHANNEL = 'whatsapp' as const;

/**
 * A decimal that reaches Meta as a JSON number without ever being a JavaScript number.
 *
 * `JSON.rawJSON` makes a token that `JSON.stringify` writes out verbatim. So the digits
 * Postgres returned for `orders.amount` are the digits in the request body — no `Number()`,
 * no rounding, no shortest-round-trip guessing about what `1234567.89` means.
 *
 * It only stays exact while nothing parses the result back, which is why `serialiseEvent`
 * exists and why `capi_events.payload` is a text column: a `JSON.parse` anywhere on the
 * path turns the token back into a double and the guarantee is gone.
 */
export interface ExactDecimal {
  readonly rawJSON: string;
}

/**
 * `JSON.rawJSON` ships unflagged from Node 22 on; this server runs Node 26 in the test
 * suite and in `deploy/Dockerfile`. TypeScript's lib has not declared it yet — as of the
 * `typescript@7` this repo pins, `JSON` carries only `parse` and `stringify`.
 *
 * So the cast is that lib gap and nothing else. Do not delete it as redundant: without it
 * the file does not compile, and replacing `rawJSON(amount)` with `Number(amount)` to make
 * the types go away is exactly the bug this whole module exists to prevent.
 */
const { rawJSON } = JSON as unknown as { rawJSON(text: string): ExactDecimal };

/** What `numeric(14,2)` can produce, and nothing else. Rejects `1e6`, `+1`, `.5`, ` 1 `. */
const DECIMAL = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;

function exactDecimal(amount: string): ExactDecimal {
  if (!DECIMAL.test(amount)) throw new Error(`Order amount is not a plain decimal: ${amount}`);

  return rawJSON(amount);
}

/**
 * The customer, reduced to the two things Meta is allowed to have: the click that started
 * the chat, and a phone nobody can read back.
 *
 * `ph` is an array because that is the shape Meta's `user_data` takes for an identifier.
 */
export interface CapiUserData {
  ctwa_clid: string;
  ph: readonly [string];
}

export interface CapiPurchaseEvent {
  event_name: 'Purchase';
  event_time: number;
  event_id: string;
  action_source: typeof ACTION_SOURCE;
  messaging_channel: typeof MESSAGING_CHANNEL;
  user_data: CapiUserData;
  custom_data: { value: ExactDecimal; currency: string };
}

export interface CapiLeadEvent {
  event_name: 'Lead';
  event_time: number;
  event_id: string;
  action_source: typeof ACTION_SOURCE;
  messaging_channel: typeof MESSAGING_CHANNEL;
  user_data: CapiUserData;
}

export type CapiEventPayload = CapiPurchaseEvent | CapiLeadEvent;

declare const bodyBrand: unique symbol;

/**
 * The finished request body: the exact bytes stored in `capi_events.payload` and the exact
 * bytes sent to Meta.
 *
 * Branded rather than a plain `string` so the two cannot drift. The column is typed as this,
 * and so is the client's body argument, which means the only way to fill either is to pass
 * an event through `serialiseEvent` — there is no signature that accepts a body somebody
 * built by hand, or one round-tripped through `JSON.parse`. The comment on the column says
 * why that matters; the type is what enforces it.
 */
export type CapiEventBody = string & { readonly [bodyBrand]: 'capi-event-body' };

/**
 * The one place an event becomes bytes. Called once, at queue time; the result is stored and
 * re-sent as it stands, so a retry and a resend by hand send what the first attempt sent.
 */
export const serialiseEvent = (event: CapiEventPayload): CapiEventBody =>
  JSON.stringify(event) as CapiEventBody;

/**
 * The stored body of a report that could never be built.
 *
 * `capi_events.payload` is not null, and a conversation with no `ctwa_clid` has nothing Meta
 * would accept: the click is captured once, on the first message, and is unrecoverable
 * afterwards. The row that records why the report was skipped still needs a payload, and an
 * event carrying an empty click id would read as sendable when it is not.
 *
 * It is never sent. The queue drains `pending`, and this only ever appears on a `skipped`
 * row — which is also why the one cast in this file's contract lives here, next to the brand
 * it makes an exception to, rather than at a call site where it would look like a shortcut.
 */
export const UNREPORTABLE_BODY = '{}' as CapiEventBody;

/**
 * The deduplication scheme, and the one thing in this file that must never change.
 *
 * Meta counts one event per `event_id`, so the id is derived from WHAT is reported and
 * never from WHEN: the same order carried by a retry, a webhook redelivery and an owner
 * pressing «Отправить снова» is one id and one conversion. The prefixes keep a purchase
 * and a lead apart even when the two ids underneath happen to be equal.
 *
 * Changing either prefix or either input after anything has shipped makes Meta treat every
 * already-reported event as new, and it will double-count everything reported since. If a
 * scheme change is ever unavoidable it has to come with a new dataset, not a new prefix.
 */
export const purchaseEventId = (orderId: string): string => `purchase:${orderId}`;
export const leadEventId = (conversationId: string): string => `lead:${conversationId}`;

/**
 * SHA-256 hex of the normalised phone, which is what Meta matches on.
 *
 * Normalised means digits only — no plus, no spaces, no punctuation. `contacts.phone` is
 * already stored that way, but a hash of the wrong string matches nobody and fails
 * silently, so this normalises rather than trusting the column's promise.
 */
export function hashPhone(phone: string): string {
  const digits = phone.toLowerCase().replace(/[^0-9]/g, '');

  return createHash('sha256').update(digits, 'utf8').digest('hex');
}

/** Whole seconds since the epoch. Meta's `event_time` is a Unix timestamp, not milliseconds. */
const unixSeconds = (at: Date): number => Math.floor(at.getTime() / 1000);

const userData = (ctwaClid: string, phone: string): CapiUserData => ({
  ctwa_clid: ctwaClid,
  ph: [hashPhone(phone)],
});

export interface PurchaseInput {
  orderId: string;
  ctwaClid: string;
  /** In any form; it is normalised and hashed, never sent. */
  phone: string;
  /** `orders.amount` exactly as the column returned it. */
  amount: string;
  currency: string;
  /** `orders.paidAt`. When the money arrived, not when we got round to reporting it. */
  paidAt: Date;
}

/**
 * `event_time` is the order's `paidAt`, not now. Meta attributes against the click, and a
 * week-old sale stamped with today lands in the wrong attribution window — the report then
 * teaches the optimiser about a day on which nothing happened.
 */
export function buildPurchase(input: PurchaseInput): CapiPurchaseEvent {
  return {
    event_name: 'Purchase',
    event_time: unixSeconds(input.paidAt),
    event_id: purchaseEventId(input.orderId),
    action_source: ACTION_SOURCE,
    messaging_channel: MESSAGING_CHANNEL,
    user_data: userData(input.ctwaClid, input.phone),
    custom_data: { value: exactDecimal(input.amount), currency: input.currency },
  };
}

export interface LeadInput {
  conversationId: string;
  ctwaClid: string;
  phone: string;
  /** When the lead reached the qualifying stage. */
  occurredAt: Date;
}

/**
 * A lead carries no money, so it carries no `custom_data` at all: an empty one or a zero
 * value would tell the optimiser a sale of nothing happened.
 */
export function buildLead(input: LeadInput): CapiLeadEvent {
  return {
    event_name: 'Lead',
    event_time: unixSeconds(input.occurredAt),
    event_id: leadEventId(input.conversationId),
    action_source: ACTION_SOURCE,
    messaging_channel: MESSAGING_CHANNEL,
    user_data: userData(input.ctwaClid, input.phone),
  };
}
