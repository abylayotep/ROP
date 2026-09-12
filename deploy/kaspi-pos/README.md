# Kaspi POS

The private sidecar uses the same pinned unofficial Kaspi Pay client as Tasbaqa.
The API stores encrypted cashier credentials per agent; the sidecar retains device
identity in its named volume. Never expose its port publicly.

## Enable

1. Set `KASPI_POS_TOKEN_SECRET_KEY` to a stable 32-byte hex secret and set
   `KASPI_POS_URL=http://kaspi-pos:3000` in `deploy/.env`.
2. Run the database migrations, then start the optional profile:
   `docker compose -f deploy/compose.yml --env-file deploy/.env --profile kaspi-pos up -d --build`.
3. Open the agent's integrations and connect the cashier using their phone and SMS.
4. Test a small invoice and verify it becomes paid only after Kaspi confirmation.

The default checkout sends an invoice to the customer's eleven-digit Kazakhstan
phone. QR is available only when explicitly selected. Replacing an outstanding
invoice with QR first requests cancellation and reads back the provider status.
A pending or already-paid invoice blocks QR creation. The backend polls invoice
`details` because live invoice creation may return `QrOperationId`, which the
upstream sidecar does not reliably register for webhook delivery. Webhooks are
therefore disabled; there is no endpoint accepting unverified paid notifications.

## Recovery

If a create times out or the process restarts before storing its operation ID,
the durable payment remains `unknown` and blocks another invoice for that dialog.
Check the cashier's operation history; do not retry blindly or manually mark paid.
An operator recovery endpoint for linking an unknown operation is not provided.
Known operation IDs are reconciled automatically after restart. Failed and expired
payments cancel their orders; provider-confirmed payments preserve the original
paid time and are the only entries in the paid orders view.

If a session expires, reconnect the cashier. A transport outage does not erase
credentials. Keep the cashier organization unchanged while payments are pending.
If Kaspi blocks the host IP, configure `KASPI_POS_PROXY_URL` with an available SOCKS
proxy. Only Kaspi domains use it. Update the pinned revision and `APP_*` together
when the provider changes its application protocol.
