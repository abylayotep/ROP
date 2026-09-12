# Automated CRM and Kaspi checkout

The funnel lives at `/a/:agentId/funnel`; `/a/:agentId/orders` lists only orders
backed by a confirmed Kaspi payment. Default final stages are ordered (awaiting
payment) and paid. Existing custom stage names are preserved.

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
cancellation first. A customer's payment claim, image or manual stage move cannot
mark an order paid: only Kaspi's confirmed operation status does so. Reconciliation
runs separately from model analysis and continues after restart for known IDs.

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
