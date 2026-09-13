# Chat-evidenced payment and one sale stage

Started on: Opus 5 · Subtasks: Opus 5

## Problem

The funnel has two stages that mean the same thing to a merchant whose customers pay by bank
transfer at the moment they order: «Заказано» (`awaiting_payment`) and «Оплачено»
(`success`). Only a Kaspi POS confirmation can put a lead into `success`, so every lead that
paid by transfer is stuck in «Заказано» forever — 20 of them on production today — and no
`Purchase` is ever reported for them.

## Decisions (made with the owner, 2026-09-14)

1. The `awaiting_payment` stage kind is removed everywhere: contract, API, cabinet, default
   funnel. Existing `awaiting_payment` stages are merged into the agent's sale stage.
2. The CRM analysis moves a lead into the sale stage itself when the conversation shows the
   payment happened. Agreement to order without visible payment is not enough; such a lead
   stays in the stage before (by default «Готов к покупке»).
3. When a lead sits in the sale stage and the chat names the amount, one paid order is
   created and a `Purchase` is queued.
4. The 20 production leads in «Заказано» move to «Оплачено» and get a `Purchase` where an
   amount is found.

Known limitation, accepted: the production number is linked by QR and has no WABA, so every
`Purchase` there is recorded as skipped with `NO_WABA` until the number moves to Cloud API.

## What counts as visible payment

The model returns a new payment state `paid`. The server accepts it only with a verbatim
quote from a real message, and only when one of these holds:

- the quoted message is from the client (`author = 'client'`) and says they paid or sent a
  transfer («оплатил», «перевела», «скинул», «төледім»);
- the quoted message is from the seller side (`phone`, `operator`, `ai`) and confirms the
  money arrived («получили оплату», «оплата пришла», «спасибо, получили»).

A receipt photo or document alone is not payment: the model cannot read attachments. It stays
`needs_verification`, as today. A photo followed by a seller confirmation is payment, through
the second rule.

The state `confirmed` (Kaspi) keeps priority over `paid`. `paid` is sticky: a later analysis
that returns `unknown` or `awaiting_payment` does not erase it. AI (worker and live agent)
never moves a lead out of the sale stage.

The CRM `paymentEvidence` state named `awaiting_payment` (card label «Ожидается») is a
different concept from the removed stage kind and stays.

## Stage resolution

`resolveCrmStage(stages, requested, { paid, currentKind })`:

- `currentKind === 'success'` → `null` (never moves a lead out of the sale stage);
- `paid` (Kaspi confirmed, or analysis `payment.state === 'paid'` accepted with
  `confidence >= 65`) → the sale stage;
- requested stage of kind `success` without `paid` → `null` (the lead stays where it is; the
  old fallback to `awaiting_payment` is gone);
- otherwise the requested stage.

The live reply agent (`lib/ai/turn.ts`) may move into the sale stage when Kaspi confirmed or
the stored CRM profile says `paymentEvidence` is `paid` or `confirmed` and no order is paid
yet (see «Operator override and repeat purchases»).

An operator may move a lead into the sale stage by hand with no payment check. The 409
«Сначала дождитесь подтверждения оплаты Kaspi…» is removed.

## Paid order from the chat

The model returns an optional `paidAmount: { value, messageId, quote }`. The server accepts it
when:

- the message is from the seller side (`phone`, `operator`, `ai`);
- the quote is verbatim in that message;
- `value` is 1–9 digits, and the digits of the quote with spaces, NBSP, dots and commas
  between digit groups removed contain `value` («6.990 тенге» → `6990`).

After the analysis is applied, the worker creates an order when all hold, inside the same
automation lock transaction as the stage move:

- the conversation's stage (after this run's move) has kind `success`;
- `paidAmount` was accepted;
- no order is paid in the current sale episode and no Kaspi payment is `pending`, `creating`
  or `unknown` (or `paid` with `confirmed_at` in the episode);
- the evidence postdates the latest paid order (see below).

The order: `amount = value`, `currency = agent.currency`, `status = 'paid'`,
`paidAt = conversations.stage_set_at` (the move time when this run moved the lead), `comment = 'Оплата по переписке'`. After the
transaction commits, `queuePurchase(db, { agentId, orderId })` runs, as the Kaspi path does.
`queuePurchase` is idempotent per order, so a retry cannot double-report.

The rule does not care who moved the lead: AI, operator or the migration. A lead moved by an
operator gets its order the next time the CRM analysis reads the conversation.

No amount → no order, no `Purchase`; the stage move still stands.

## Orders and statistics

- `GET /api/agents/:agentId/orders` lists every paid order: the inner join on
  `kaspi_payments` becomes a left join, and the filter is `orders.status = 'paid'` and
  (no Kaspi row or Kaspi row `paid`).
- The orders screen says «Покупки с подтверждённой оплатой», and the verification column
  shows «✓ Kaspi · оплачено» with the operation id for Kaspi rows and «По переписке» for the
  rest.
- Statistics revenue already sums paid orders; verify it does not join Kaspi and keep it.

## Cabinet

- `FunnelSettings`: the «Ждёт оплаты» kind option is removed.
- `StatsScreen`: the `awaiting_payment` color branch is removed (historic transition rows
  fall through to the neutral color).
- `LeadPanel`: `paymentEvidence === 'paid'` shows «Оплачено по переписке» with the reason.

## Operator override and repeat purchases

Added after the final review, with the owner.

- **Operator undo.** When the latest move into or out of the sale stage is an operator taking
  the lead out (`operatorLeftSale`), chat evidence no longer moves it back and no chat order
  is recorded; a Kaspi payment confirmed after that still moves it. Anyone putting the lead
  back into the sale stage clears this.
- **Deleting a chat order.** A paid order with no Kaspi row may be deleted, but only while the
  lead is outside the sale stage (409 «Сначала выведите сделку из стадии «Оплачено», затем
  удалите заказ»). Kaspi-paid orders stay immutable.
- **One order per sale episode.** An episode starts when the lead last entered the sale stage
  (`stage_set_at`); only a paid order with `paid_at` at or after it blocks a new chat order
  (`hasPaidOrderInSaleEpisode`). Kaspi sets `stage_set_at = confirmed_at` when it moves a lead.
- **Fresh evidence.** The paid claim's message and the price message must both be sent after
  `greatest(paid_at, created_at)` of the conversation's latest paid order (Kaspi or chat); a
  chat order is backdated to the stage entry, which can precede its own messages. A Kaspi
  payment counts for the worker only while the lead is in the sale stage or was paid after
  its current stage was set.
- **Kaspi invoices.** `createKaspiCheckout` (operator route and AI checkout) refuses with 409
  «У сделки уже есть оплаченный заказ» only while the lead is in the sale stage with a paid
  order in the current episode. A 409 from the AI checkout becomes a note and the ordinary
  reply, not a failed analysis.
- **Purchase recovery.** `queueMissingPurchases` runs every 60 s on its own timer and logs the
  ids of orders it still could not queue.

## Migration `0050_merge_awaiting_payment.sql`

For every stage with `kind = 'awaiting_payment'` whose agent has a `success` stage:

1. Insert one `stage_transitions` row per conversation in it: from that stage to the sale
   stage, snapshots of name/kind/position, `moved_by = 'system'`, `occurred_at = now()`.
2. Update those conversations: `stage_id` = sale stage, `stage_set_at = now()`,
   `stage_set_by = 'system'`.
3. Delete the `awaiting_payment` stage.
4. Renumber the agent's remaining stages `position` 0..n-1 in current order.
5. Update the default texts `0046_stage_agent_goal` wrote for «Готов к покупке» (helping the
   customer pay moves here) and «Оплачено» (description no longer Kaspi-only), only where they
   are still the defaults.

The analyses of merged leads are **not** reset in the migration: releases migrate while the
old API still runs and roll back to it on a failed health check, and the old worker would
demote the merged leads. The reset is a post-release SQL step in `docs/crm-kaspi.md`
(«Releasing migration 0050»), run once the new API is healthy.

An `awaiting_payment` stage whose agent has no `success` stage (not expected; the API keeps
exactly one) is converted to `kind = 'active'` instead, with its leads left in place.

Migration 0005 (the historic seed) is not edited.

## Out of scope

- Operators recording a paid order by hand (`POST …/orders` still refuses `status: 'paid'`).
- Reading receipt images.
- Refunds of a chat order (an operator can only undo a false one, see above).

## Acceptance

- Default funnel for a new agent has 8 stages, no «Заказано».
- `POST/PATCH /stages` with `kind: 'awaiting_payment'` → 400.
- CRM analysis on a chat where the client writes «перевела 6990» after the seller quoted
  «6.990 тенге» moves the lead to «Оплачено», creates one paid order of 6990 KZT, queues one
  `Purchase` (or a skipped row with its reason).
- Same chat analysed twice → still one order, one `Purchase` row.
- Client sends only a photo → `needs_verification`, no move.
- Client agrees to order, no payment words → lead not in the sale stage.
- Lead in the sale stage, later analysis without payment → stays in the sale stage.
- Operator drags a lead into «Оплачено» without Kaspi → 200.
- Kaspi invoice pending for the conversation → no chat order.
- Migration on a DB with leads in an `awaiting_payment` stage → leads in the sale stage, one
  transition each, stage gone, positions contiguous, analyses untouched until the
  post-release step.
- `npm test` in `server` and the cabinet type check pass.
