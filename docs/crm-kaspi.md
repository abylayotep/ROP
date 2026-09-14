# Automated CRM and Kaspi checkout

The funnel lives at `/a/:agentId/funnel`; `/a/:agentId/orders` lists paid orders: those
backed by a confirmed Kaspi payment and those recorded from a payment seen in the chat.
The default funnel ends with one sale stage (paid) and a refusal stage. Existing custom
stage names are preserved.

## Analysis

An agent with an OpenRouter key receives incremental background analysis for both
existing and new conversations, independently of its auto-reply switch. History
is scanned in bounded pages with recent messages included for current context.
The worker stores progress and renews its lease while processing.

Customer name, phone, city, address, product, quantity, amount, delivery and declared
source require message evidence. Custom fields must match their configured type.
Newer evidence wins over imported old history; operator edits to custom fields are
preserved. Missing information remains unknown. The profile is displayed in the
customer card, along with analysis state and summary.

Advertising attribution comes from actual WhatsApp Cloud referrals or linked-device
external ad metadata. Ordinary link previews are not attribution. Existing source
metadata is preserved. Campaign names and identifiers absent from the provider
payload are not guessed from message text or URLs.

## Checkout and payment

Follow [the POS deployment guide](../deploy/kaspi-pos/README.md) to enable the private
Tasbaqa-compatible sidecar and connect the cashier by phone and SMS.

Automatic checkout requires a fresh live customer request, enabled auto-replies,
an available WhatsApp connection, and an explicit final seller total in KZT. The
default is a phone invoice to the contact's actual number. Explicit QR requests
produce a PNG sent through the connected WhatsApp transport. Negative requests,
questions about QR and unsupported amounts do not create payments. Imported history
never initiates checkout or customer messages.

Payment intents are persisted before calling Kaspi. Ambiguous creation blocks
automatic retries. WhatsApp payment notifications are also claimed durably before
sending; uncertain delivery is shown in the payment card and is not retried
automatically. Switching an outstanding invoice to QR requires confirmed
cancellation first. Reconciliation runs separately from model analysis and continues
after restart for known IDs.

An order becomes paid in two ways. Kaspi's confirmed operation status marks its invoice
order paid. Otherwise, when the analysis quotes the customer saying they paid (or the
seller confirming receipt) with confidence and the seller quoted a price, the worker moves
the lead into the sale stage and records one paid order «Оплата по переписке» for that
price, unless a Kaspi invoice for the conversation is in flight. A paid claim with no
quoted price does not move the lead: it stays on the lead card as paid evidence, so the
sale stage never fills with chat sales the orders list cannot show. The order's `paid_at`
is when the quoted payment message was sent, not when the analysis ran.

A lead already standing in the sale stage gets a chat order only on the same paid claim,
or, when an operator put it there, on the quoted price alone (the operator's move is the
payment assertion; `paid_at` is then the move time). A lead moved there by the system,
a scenario or the AI gets no order from a price alone. One order per sale episode: an order
paid since the lead last entered the sale stage blocks another, an older one does not. Either way a Meta Purchase is queued;
a sweep every minute re-queues purchases lost for orders paid in the last seven days. An
image alone, or an operator, cannot mark an order paid by hand.

AI never takes a lead out of the sale stage. An operator can undo a false chat sale: move
the lead out of the sale stage, then delete the chat order (deleting it while the lead is
still in the sale stage is refused). After such a move neither the worker nor the live
agent moves the lead back into the sale stage on chat evidence, and no new chat order is
recorded; a Kaspi payment confirmed after the move still moves it. Orders paid through
Kaspi cannot be changed or deleted.

A conversation holds the customer's whole relationship, so repeat purchases work: a lead
standing in the sale stage with a paid order gets no new Kaspi invoice, manual or
automatic, but once moved out of the sale stage it can be invoiced again, and a manager
who moves it back into the sale stage lets the next chat payment record a new order and
Purchase. Payments from an earlier sale never move the lead back: chat evidence counts only
when both the payment and the quoted price were written after the latest paid order.

## Dialog performance

The dialog list fetches 100 conversations per page. Threads fetch and render bounded
60-message windows, with older/newer navigation and direct source-message links.
Message components are memoized and media loads lazily. Polling retains loaded
content and pauses in hidden tabs. The complete history remains accessible.

## Validation and limits

Automated coverage exercises payment status checks, duplicate and uncertain requests,
QR opt-in, tenant access, historical analysis, concurrent edits, leases, referral
capture, pagination and source links. Local fake transports do not establish that a
production cashier session is connected. After deployment, verify a small real
invoice and its confirmed payment before enabling unattended checkout.

## Repairing orders recorded after migration 0050

Migration 0050 put Sealhouse's 20 «Заказано» leads into «Оплачено», and the re-analysis
that followed recorded 5 chat orders, all dated at the merge (2026-09-13 23:26 UTC). Two
quote a customer's «Оплатил»; three had only a price in the chat. The worker no longer
does either. Run this once, after the release with the fix is healthy, in one transaction:

```sql
BEGIN;
-- 1. Date the chat orders from that re-analysis by the payment message they were recorded
--    from: the latest client «оплатил/перевёл…» or seller «деньги получили…» text sent
--    before the order was recorded. Orders with no such message keep their paid_at.
WITH evidence AS (
  SELECT o.id, (
    SELECT max(m.sent_at) FROM messages m
    WHERE m.conversation_id = o.conversation_id AND m.kind = 'text' AND m.sent_at <= o.created_at
      AND ((m.author = 'client' AND m.body ~* '(оплатил|оплачено|перев[её]л|перевели|отправил[аи]? (деньги|оплату)|аудардым|төледім|төлеп (қойдым|жібердім))')
        OR (m.author IN ('phone', 'operator', 'ai') AND m.body ~* '(оплат|деньг|перевод|төлем|ақша)'
          AND m.body ~* '(получил|поступил|пришл[аи]|келді|түсті)'))
  ) AS sent_at
  FROM orders o
  WHERE o.comment = 'Оплата по переписке' AND o.status = 'paid'
    AND o.created_at >= '2026-09-13 23:26:38+00' AND o.created_at < '2026-09-14 01:00+00'
    AND NOT EXISTS (SELECT 1 FROM kaspi_payments k WHERE k.order_id = o.id)
)
UPDATE orders o SET paid_at = e.sent_at
FROM evidence e
WHERE o.id = e.id AND e.sent_at IS NOT NULL AND o.paid_at IS DISTINCT FROM e.sent_at;
-- 2. Delete the chat orders from that re-analysis that no payment message backs, on leads
--    no operator put into the sale stage. Their Purchases were never sent (skipped).
DELETE FROM orders o
USING conversations c
WHERE c.id = o.conversation_id
  AND o.comment = 'Оплата по переписке' AND o.status = 'paid'
  AND o.created_at >= '2026-09-13 23:26:38+00' AND o.created_at < '2026-09-14 01:00+00'
  AND c.stage_set_by IS DISTINCT FROM 'operator'
  AND NOT EXISTS (SELECT 1 FROM kaspi_payments k WHERE k.order_id = o.id)
  AND NOT EXISTS (SELECT 1 FROM crm_analyses ca WHERE ca.conversation_id = c.id
    AND ca.profile->>'paymentEvidence' IN ('paid', 'confirmed'))
  AND NOT EXISTS (
    SELECT 1 FROM messages m
    WHERE m.conversation_id = o.conversation_id AND m.kind = 'text' AND m.sent_at <= o.created_at
      AND ((m.author = 'client' AND m.body ~* '(оплатил|оплачено|перев[её]л|перевели|отправил[аи]? (деньги|оплату)|аудардым|төледім|төлеп (қойдым|жібердім))')
        OR (m.author IN ('phone', 'operator', 'ai') AND m.body ~* '(оплат|деньг|перевод|төлем|ақша)'
          AND m.body ~* '(получил|поступил|пришл[аи]|келді|түсті)')));
-- 3. Return the merged leads that still have no paid order to «Готов к покупке», where the
--    migration's own texts put «agreed and waiting for payment». Only leads whose latest move
--    is still the merge; each move is recorded like any other system move.
WITH merged AS (
  SELECT c.id, c.agent_id, c.stage_id, s.name AS from_name, s.position AS from_position,
    r.id AS to_id, r.name AS to_name, r.kind AS to_kind, r.position AS to_position
  FROM conversations c
  JOIN stages s ON s.id = c.stage_id AND s.kind = 'success'
  JOIN stages r ON r.agent_id = c.agent_id AND btrim(r.name) = 'Готов к покупке' AND r.kind = 'active'
  JOIN LATERAL (
    SELECT t.* FROM stage_transitions t WHERE t.conversation_id = c.id
    ORDER BY t.occurred_at DESC, t.id DESC LIMIT 1
  ) st ON true
  WHERE c.stage_set_by = 'system'
    AND st.moved_by = 'system' AND st.to_kind = 'success' AND st.to_stage_id = c.stage_id
    AND st.from_stage_id IS NULL AND st.from_name IS NOT NULL
    AND st.occurred_at >= '2026-09-13 23:26:38+00' AND st.occurred_at < '2026-09-13 23:26:39+00'
    AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.conversation_id = c.id AND o.status = 'paid')
), moved AS (
  UPDATE conversations c SET stage_id = m.to_id, stage_set_at = now(), stage_set_by = 'system'
  FROM merged m WHERE c.id = m.id AND c.stage_id = m.stage_id
  RETURNING c.id
)
INSERT INTO stage_transitions (agent_id, conversation_id, from_stage_id, to_stage_id, from_name, to_name, to_kind, from_position, to_position, moved_by, occurred_at)
SELECT m.agent_id, m.id, m.stage_id, m.to_id, m.from_name, m.to_name, m.to_kind, m.from_position, m.to_position, 'system', now()
FROM merged m JOIN moved USING (id);
COMMIT;
```

On 2026-09-14 the read-only preview of these conditions matched: step 1 two orders (to
2026-09-03 16:55 and 2026-09-09 06:33 UTC), step 2 three orders, step 3 eighteen leads
(the fifteen without an order plus the three from step 2), leaving two leads in «Оплачено»
with their two orders. Three of the eighteen have an unread receipt attachment
(`paymentEvidence = needs_verification`): an operator checks them and drags the paid ones
back into «Оплачено». Every statement is bounded to the merge and its re-analysis, so a
second run changes nothing. No analysis is re-queued and no model is called.

## Releasing migration 0050

Migration `0050_merge_awaiting_payment` moves every lead in an awaiting-payment stage into
its agent's sale stage. It does not reset those leads' analyses: `deploy/release.sh` runs
migrations while the previous API is still serving, and restarts the previous API when the
new one fails its health check, so an analysis reset inside the migration would let the old
worker re-analyse the merged leads and move them out of the sale stage.

Run the reset by hand, **only after the release has printed `api healthy` for the new
API**. It re-queues analysis for leads whose latest move is the migration's merge, so the
new worker records their chat order and Purchase where the chat shows an amount:

```sql
UPDATE crm_analyses ca
SET analyzed_message_id = NULL, status = 'pending', lease_token = NULL, lease_until = NULL, updated_at = now()
FROM conversations c
JOIN stages s ON s.id = c.stage_id AND s.kind = 'success'
JOIN LATERAL (
  SELECT t.* FROM stage_transitions t WHERE t.conversation_id = c.id
  ORDER BY t.occurred_at DESC, t.id DESC LIMIT 1
) st ON true
WHERE ca.conversation_id = c.id
  AND c.stage_set_by = 'system'
  AND st.moved_by = 'system' AND st.to_kind = 'success' AND st.to_stage_id = c.stage_id
  AND st.from_stage_id IS NULL AND st.from_name IS NOT NULL
  AND st.occurred_at > now() - interval '2 days';
```

On the host: `cd /opt/rakurs && docker compose -f deploy/compose.yml --env-file deploy/.env
exec -T postgres psql -U rakurs rakurs`, then paste the statement. The merged transition is
recognised by its deleted source stage (`from_stage_id` is null once 0050 deletes it) and a
system move into the sale stage; the two-day bound keeps it to the release, so run it the
same day. Running it twice only re-analyses the same leads again.
