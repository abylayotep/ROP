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
seller confirming receipt) with confidence, the worker moves the lead into the sale stage
and records one paid order «Оплата по переписке» for the amount the seller quoted, unless
a Kaspi invoice for the conversation is in flight. One order per sale episode: an order
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

## Releasing migration 0046

Migration `0046_merge_awaiting_payment` moves every lead in an awaiting-payment stage into
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
recognised by its deleted source stage (`from_stage_id` is null once 0046 deletes it) and a
system move into the sale stage; the two-day bound keeps it to the release, so run it the
same day. Running it twice only re-analyses the same leads again.
