### Task 4: Sending, retrying, giving up

**Files:**
- Create: `server/src/lib/capi/queue.ts`
- Modify: `server/src/lib/whatsapp/inbound.ts` or wherever the existing pass is driven from — read it first and put the drain where it belongs
- Modify: `server/src/api/whatsapp-webhook.ts` and `server/src/api/server.ts` (pass the client through)
- Create: `server/test/capi-queue.test.ts`

**Interfaces:**
- Consumes: `CapiClient`, `CapiError` from task 2; `capiEvents`, `capiSettings`; `decryptSecret`; `withoutSecret`.
- Produces: `sendPendingCapiEvents(db, deps)` returning what it did.

**Context.** Draining the queue. `server/src/lib/whatsapp/inbound.ts` already does exactly this shape for WhatsApp events — the claim with `for update skip locked`, the attempts cap, the error column. Read it and follow it; two queues in one codebase that behave differently is how one of them ends up wrong.

**The rules:**

- Claim pending rows with `for update skip locked` and `attempts < 5`, so two passes cannot send the same event twice.
- Count the attempt before the work, not after — an event that always throws must stop being picked up.
- Back off: do not retry an event whose last attempt was seconds ago. A widening gap by attempt number, computed from `attempts` and the row's timestamp, with no new column if you can avoid one — say what you chose.
- A `CapiError` that is not retryable fails the event immediately, whatever its attempt count. There is no point spending five attempts on an invalid token.
- On success write `status: 'sent'`, `sentAt`, and clear the error.
- On failure write the reason, redacted with `withoutSecret` against the decrypted token — Meta echoes a rejected token in its own error text, which is the leak stage 2 shipped once and caught.
- Decrypt inside the try, so a key that no longer matches costs one event rather than the whole pass. Stage 2's inbound path has this exact shape and the comment explaining it.
- Send events in one batch per agent where they are pending together: Meta accepts an array, and one request for five sales is better than five.

**Where the drain runs.** It must not be on the webhook's request path — Meta is waiting there. Put it where the existing pass runs, after the response, and cap how long one drain may take so a slow Meta cannot pile passes on each other.

- [x] **Step 1: Write the failing test**

Create `server/test/capi-queue.test.ts` with `fakeCapi` injected. Cover: a pending event is sent and marked; the token reaches the client decrypted and never reaches the stored error; a retryable refusal increments attempts and stays pending; a non-retryable one fails at once; the cap stops an event that always fails; two concurrent drains send one event once; several pending events for one agent go in one call; an event whose agent's settings were disabled after queueing is skipped rather than sent.

- [x] **Step 2: Run it and watch it fail**

- [x] **Step 3: Write it**

- [x] **Step 4: Run everything and commit**

```bash
npm --prefix server test
npm --prefix server run typecheck
git add server
git commit -m "Send queued conversions, and stop when Meta will never take them"
```
