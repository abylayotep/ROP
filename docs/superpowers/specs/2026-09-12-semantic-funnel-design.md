# Semantic Funnel and Embedded Conversation Design

## Outcome

The funnel becomes the primary sales workspace. Clients are assigned using conversation meaning and retained prior context. A card opens its conversation in a modal. Payment intent, customer payment evidence, and confirmed payment remain distinguishable.

## Constraints

- Preserve unrelated existing work, including Instagram changes in the dirty worktree.
- Keep durable code and documentation in English; customer-facing UI and seller instructions use the product language.
- Keep each maintained Markdown file below 500 lines.
- Reuse current CRM stages, conversation APIs, and Kaspi POS reconciliation.
- Do not mark orders paid without authoritative evidence or weaken existing payment verification.
- Do not send customer messages or create live invoices during development or validation.

## Conversation Understanding

The current incremental worker must retain earlier relevant facts rather than interpreting a recent slice as a complete conversation. Include the previous analysis summary, stage, fields, and profile with ordered new/recent messages. Clearly identify previous conclusions as revisable context and new messages as evidence; later corrections supersede earlier intent. On initial/backfill analysis, process history in order and accumulate meaningful context. Do not claim that omitted history was read.

Classification considers the actual stage descriptions, customer and seller roles, negation, completed actions, unresolved questions, and the latest relevant commitment. Merely mentioning payment or receiving seller payment instructions does not establish purchase or payment. The same evidence rules apply to Russian and Kazakh conversation text. Preserve deterministic confirmed-payment reconciliation.

## Payment Interpretation

Represent payment evidence independently of funnel stage, using the current extensible CRM fields if suitable:

- Unknown: available conversation and provider data do not establish payment.
- Awaiting payment: explicit outstanding invoice or intent to pay, with no later completion evidence.
- Requires verification: customer reports completing a transfer or supplies a possible receipt, without provider confirmation.
- Confirmed: the existing authoritative Kaspi POS reconciliation verifies a completed payment.

Expose a short evidence explanation in the lead view. A missing receipt does not prove nonpayment. An attachment alone is not a verified receipt. A customer statement or receipt cannot set `orders.status='paid'`. Handle denial, failed transfers, pending receipts, and later corrections without stale positive classifications. Provider confirmation wins over model guesses.

Pass attachment types/captions to analysis so receipt candidates are not invisible. Reuse a supported existing media interpretation path if available; otherwise label an unread attachment as requiring inspection and explicitly avoid claiming to have read its contents. Building a new bank integration or general document OCR service is outside this change.

## Seller Payment Instructions

The user identified the seller as **Sealhouse**. Make these instructions available to that seller assistant using the existing agent configuration/rules mechanism. Resolve an explicitly configured agent ID or a unique normalized exact Sealhouse name; do not guess between duplicate matches. Do not overwrite other agent rules or apply one seller's payment details indiscriminately to unrelated agents.

- Kaspi transfer: `+77066241022`, recipient `Құралай А.`.
- Halyk / Narodny transfer: `+77479041022`, recipient `Құралай А.`.
- Payment invoices: use the existing Kaspi POS workflow.

Choose the requested method from context; do not invent an invoice URL or report payment confirmation from a promise. Store the instructions durably and ensure existing relevant agents receive them without a destructive reseed.

## Funnel UX

Remove the Dialogues menu entry and standalone working screen. Legacy conversation links should redirect into the funnel and open the requested conversation where practical.

Clicking a client card opens a reusable conversation workspace in a modal, with the message thread, composer, client details, stage, and payment evidence. Reuse existing media and send behavior. Preserve the board position and filters on close. Prevent drag completion from opening a card accidentally. Refresh affected board data after conversation or lead changes.

Provide a visible close button, Escape and backdrop close, dialog semantics, sensible initial focus, focus containment/restoration, scroll locking, and a responsive near-fullscreen layout on small screens. Keep message content scrollable and the composer accessible. Handle loading, failure, missing conversation, and empty history without blank overlays.

## Acceptance

1. Earlier purchase facts survive incremental analysis; a later cancellation/correction can change the stage.
2. Seller bank details, future promises, negation, and hypothetical payment do not become confirmed payments.
3. A claim without a receipt and a receipt candidate without bank confirmation are visibly unverified, not categorically unpaid or confirmed.
4. Kaspi POS confirmation still updates order and success stage through the existing verified flow.
5. The seller assistant has the exact method-specific numbers and recipient, and uses POS for invoices.
6. No Dialogues navigation remains; funnel cards open a usable chat modal and close back to the same board.
7. Meaningful server/UI regressions and type checks pass, with any pre-existing failures explicitly separated.
