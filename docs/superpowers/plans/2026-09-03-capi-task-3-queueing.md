### Task 3: Queueing what happened

**Files:**
- Create: `server/src/lib/capi/enqueue.ts`
- Modify: `server/src/api/orders.ts` (an order becoming paid)
- Modify: `server/src/api/leads.ts` (a lead reaching a qualified stage)
- Modify: `server/src/lib/ai/turn.ts` (the agent's stage move takes the same road)
- Create: `server/test/capi-enqueue.test.ts`

**Interfaces:**
- Consumes: `buildPurchase`, `buildLead`, `purchaseEventId`, `leadEventId` from task 1.
- Produces: `queuePurchase(db, { agentId, orderId })` and `queueLead(db, { agentId, conversationId })`, both of which never throw.

**Context.** The hooks. Marking an order paid must not fail because this code has a bad day, so both functions swallow their own errors the way `sendStageMessage` does — an unqueued event is a report that did not go, and a 500 in the operator's face over an order they did record is worse.

**When a purchase is queued:** an order's status becomes `paid` and it was not `paid` before. Not on every save of a paid order — that is why `orders.ts` already compares against the current row.

**When a lead is queued:** a conversation enters a stage whose `kind` is `qualified`, and no lead event exists for it. The uniqueness of `eventId` enforces the "once" — write the insert so a conflict is a no-op rather than an error, and say in a comment that the constraint is the rule and the check is only there to avoid the round trip.

**What is skipped, and why it is recorded rather than ignored:** a conversation with no `ctwa_clid`, an agent with no settings row, or settings that are disabled. Write a `skipped` row with the reason in `error` — an owner asking "why was this sale not reported" deserves an answer, and silence is not one. A skipped row still takes its `eventId`, so if the reason is later fixed, a resend by hand is what reports it, deliberately, rather than a background pass doing it by surprise.

- [ ] **Step 1: Write the failing test**

Create `server/test/capi-enqueue.test.ts`, driving the real routes the way `server/test/orders-api.test.ts` does. Cover:

- marking an order paid on an ad-sourced conversation queues one pending purchase with the order's amount, currency and paid time;
- marking it paid again queues nothing more;
- an order paid on a conversation with no `ctwa_clid` writes a `skipped` row saying so, and queues nothing pending;
- an agent with no settings, and one with settings disabled, both write `skipped` with their own reasons;
- a lead entering a qualified stage queues one lead event; entering it again queues nothing;
- the agent's own stage move queues it too — the same road, which is the point of stage 5 using the operator's path;
- a failure inside queueing does not fail the order route: force it and assert the order is still marked paid.

- [ ] **Step 2: Run it and watch it fail**

- [ ] **Step 3: Write it**

- [ ] **Step 4: Run everything and commit**

```bash
npm --prefix server test
npm --prefix server run typecheck
git add server
git commit -m "Queue a conversion when the money or the stage says so"
```
