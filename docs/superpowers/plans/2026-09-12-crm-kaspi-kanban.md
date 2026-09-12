# Automated funnel, verified Kaspi orders, and responsive dialogs

## Accepted behavior

- Separate the editable funnel at `/funnel` from provider-confirmed orders at `/orders`.
- Classify existing and new conversations independently of the auto-reply switch.
- Extract supported customer fields from message evidence; never invent ad attribution.
- Default Kaspi checkout to an invoice sent to the payer's phone. QR requires an explicit request.
- Confirm money using the same POS operation checks as Tasbaqa. Never infer payment from chat.
- Historical analysis must not invoice or message old customers.
- Keep dialog navigation, typing, and history loading responsive with large datasets.

## Implementation

1. Port the Tasbaqa POS client, encrypted cashier session, auth UI, durable checkout and payment reconciliation. Preserve its invoice operation-id variants and exact payment status handling. Protect against duplicate creation and ambiguous network outcomes.
2. Add persistent CRM analysis state with bounded incremental background work. Parse structured model output, verify field evidence, guard concurrent operator edits, and record stage transitions. No customer side effects in the historical worker.
3. Capture linked-device advertising metadata as well as Cloud API referrals. Display actual source identifiers and unknown values honestly.
4. Add kanban search, bounded scroll, visible classification state and updates. Route confirmed paid orders to their own view.
5. Diagnose and remove dialog rendering and data-loading bottlenecks, preserving source links and access to older messages.
6. Wire workers after HTTP startup; require deployed POS configuration and cashier login before real checkout.

## Verification

- Regression tests for unconfirmed/pending/failed payments, operation mismatch, repeated checkout, QR opt-in, and tenant isolation.
- CRM tests with auto-replies disabled, historical conversations, invalid evidence, concurrent edits, model failure and repeat analysis.
- Dialog tests with large histories and list sizes, message navigation, and incremental loading.
- Run focused tests, TypeScript checks, frontend build, then relevant integration suites.
- No live payment, customer message, production migration or deployment is part of local verification.
