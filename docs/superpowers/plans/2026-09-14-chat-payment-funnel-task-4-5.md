# Chat Payment Funnel — Tasks 4–5 (worker, orders, cabinet)

> Part of `2026-09-14-chat-payment-funnel.md` — read its header and Global Constraints first; they apply to every task here.

### Task 4: Worker moves on payment, records the chat order, gates removed

**Files:**
- Create: `server/src/lib/crm/payment.ts`
- Modify: `server/src/lib/crm/worker.ts:170-265`
- Modify: `server/src/lib/ai/turn.ts:654-655,737`
- Modify: `server/src/api/leads.ts:20,131-133,239-241`
- Test: `server/test/crm-worker.test.ts`, `server/test/leads-api.test.ts`

**Interfaces:**
- Consumes: Task 3 `resolveCrmStage`, `CrmAnalysis.paidAmount`, `payment.state === 'paid'`; `queuePurchase(db, { agentId, orderId })` from `lib/capi/enqueue.ts`; `hasConfirmedKaspiPayment` from `lib/kaspi/service.ts`.
- Produces: `hasVisiblePayment(db: Db, agentId: string, conversationId: string): Promise<boolean>`.

- [ ] **Step 1: Write failing worker tests**

In `crm-worker.test.ts` (reuse `beforeEach`; import `orders`, `kaspiPayments`):
```ts
  const sale = async () => (await db.select().from(stages).where(eq(stages.agentId, agentId))).find((s) => s.kind === 'success')!;
  const paidChat = async () => {
    const [offer] = await db.insert(messages).values({ conversationId, direction: 'out', author: 'phone', kind: 'text',
      body: 'Размер 40 мм — 6.990 тенге', sentAt: new Date('2026-01-01T00:01:00Z') }).returning();
    const [transfer] = await db.insert(messages).values({ conversationId, direction: 'in', author: 'client', kind: 'text',
      body: 'Перевела 6990, спасибо', sentAt: new Date('2026-01-01T00:02:00Z') }).returning();
    model.complete.mockResolvedValue({ text: JSON.stringify({ stageId: null, summary: 'Оплатила переводом', confidence: 90, profile: {}, fields: {},
      checkout: null, payment: { state: 'paid', messageId: transfer!.id, quote: 'Перевела 6990', reason: 'Клиент перевёл оплату' },
      paidAmount: { value: '6990', messageId: offer!.id, quote: '6.990 тенге' } }), promptTokens: 1, completionTokens: 1, cost: '0' });
  };

  it('moves a lead that paid by transfer to the sale stage and records one paid order', async () => {
    await paidChat();
    await analyzeConversation(db, { model, key }, { agentId, conversationId });
    const [conversation] = await db.select().from(conversations).where(eq(conversations.id, conversationId));
    expect(conversation?.stageId).toBe((await sale()).id);
    const rows = await db.select().from(orders).where(eq(orders.conversationId, conversationId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ amount: '6990.00', status: 'paid', comment: 'Оплата по переписке' });
    expect(rows[0]!.paidAt?.getTime()).toBe(conversation!.stageSetAt!.getTime());
    expect((await db.select().from(capiEvents)).filter((e) => e.kind === 'purchase')).toHaveLength(1);
    const [analysis] = await db.select().from(crmAnalyses).where(eq(crmAnalyses.conversationId, conversationId));
    expect(analysis?.profile.paymentEvidence).toBe('paid');
  });

  it('does not record a second order when the conversation is analysed again', async () => {
    await paidChat();
    await analyzeConversation(db, { model, key }, { agentId, conversationId });
    await db.insert(messages).values({ conversationId, direction: 'in', author: 'client', kind: 'text', body: 'Когда отправите?', sentAt: new Date('2026-01-01T00:03:00Z') });
    await analyzeConversation(db, { model, key }, { agentId, conversationId });
    expect(await db.select().from(orders)).toHaveLength(1);
    expect((await db.select().from(capiEvents)).filter((e) => e.kind === 'purchase')).toHaveLength(1);
  });

  it('gives an operator-moved sale its order once the amount is found, and never leaves the sale stage', async () => {
    await db.update(conversations).set({ stageId: (await sale()).id, stageSetAt: new Date('2026-01-02T00:00:00Z') }).where(eq(conversations.id, conversationId));
    await paidChat();
    const text = JSON.parse((await model.complete.getMockImplementation()!()).text);
    model.complete.mockResolvedValue({ text: JSON.stringify({ ...text, stageId: targetId, payment: null }), promptTokens: 1, completionTokens: 1, cost: '0' });
    await analyzeConversation(db, { model, key }, { agentId, conversationId });
    expect((await db.select().from(conversations))[0]?.stageId).toBe((await sale()).id);
    expect((await db.select().from(orders))[0]?.paidAt?.toISOString()).toBe('2026-01-02T00:00:00.000Z');
  });

  it('records no chat order while a Kaspi invoice is pending', async () => {
    await paidChat();
    const [order] = await db.insert(orders).values({ agentId, conversationId, amount: '6990', currency: 'KZT' }).returning();
    await db.insert(kaspiPayments).values({ agentId, conversationId, orderId: order!.id, method: 'invoice', phone: '77011234567', amount: '6990', status: 'pending' });
    await analyzeConversation(db, { model, key }, { agentId, conversationId });
    expect((await db.select().from(orders)).filter((o) => o.status === 'paid')).toHaveLength(0);
  });

  it('does not move on a paid claim below the confidence threshold', async () => {
    await paidChat();
    const text = JSON.parse((await model.complete.getMockImplementation()!()).text);
    model.complete.mockResolvedValue({ text: JSON.stringify({ ...text, confidence: 50 }), promptTokens: 1, completionTokens: 1, cost: '0' });
    await analyzeConversation(db, { model, key }, { agentId, conversationId });
    expect((await db.select().from(conversations))[0]?.stageId).not.toBe((await sale()).id);
    expect(await db.select().from(orders)).toHaveLength(0);
  });
```
Adjust `kaspiPayments` insert to the table's real required columns (read `schema.ts`). `targetId` in `beforeEach` is the first seeded stage («Новый лид»).

In `leads-api.test.ts` add a test that `PATCH …/lead` with the sale stage id and no Kaspi payment returns 200 and the lead's `stageId` is the sale stage (follow the file's existing move test).

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && npx vitest run test/crm-worker.test.ts test/leads-api.test.ts` (sandbox disabled)
Expected: FAIL (no move, no order; 409 on the operator move).

- [ ] **Step 3: Implement**

`server/src/lib/crm/payment.ts`:
```ts
import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { crmAnalyses } from '../../db/schema.js';
import { hasConfirmedKaspiPayment } from '../kaspi/service.js';

/** Money a lead may be moved into the sale stage on: Kaspi confirmed it, or the chat showed it. */
export async function hasVisiblePayment(db: Db, agentId: string, conversationId: string): Promise<boolean> {
  if (await hasConfirmedKaspiPayment(db, agentId, conversationId)) return true;
  const [row] = await db.select({ profile: crmAnalyses.profile }).from(crmAnalyses).where(eq(crmAnalyses.conversationId, conversationId));
  return row?.profile.paymentEvidence === 'paid';
}
```

`worker.ts`:
1. After `parseCrmAnalysis`:
```ts
    // A paid claim the model is unsure of is not stored, so it can neither move the lead nor stick.
    const payment = analysis.payment?.state === 'paid' && analysis.confidence < 65 ? null : analysis.payment;
    const target = resolveCrmStage(funnel, analysis.confidence >= 65 ? analysis.stageId : null,
      { paid: paid || payment?.state === 'paid', currentStageId: conversation.stageId });
```
2. In the transaction: capture `const movedAt = new Date();` and use it for `stageSetAt` in the move. After the move:
```ts
      const stageNow = moved ? target : target && target.id !== conversation.stageId ? null
        : funnel.find((s) => s.id === conversation.stageId) ?? null;
```
3. Replace `analysis.payment` with `payment` in the `resolvePaymentEvidence` call.
4. Before the `crmAnalyses` update:
```ts
      // One paid order per sale, whoever moved the lead there. A Kaspi invoice in flight owns the money.
      if (stageNow?.kind === 'success' && analysis.paidAmount) {
        const [paidOrder] = await tx.select({ id: orders.id }).from(orders)
          .where(and(eq(orders.conversationId, conversation.id), eq(orders.status, 'paid'))).limit(1);
        const [invoice] = await tx.select({ id: kaspiPayments.id }).from(kaspiPayments)
          .where(and(eq(kaspiPayments.conversationId, conversation.id), inArray(kaspiPayments.status, ['creating', 'pending', 'unknown', 'paid']))).limit(1);
        if (!paidOrder && !invoice) {
          const [order] = await tx.insert(orders).values({ agentId: agent.id, conversationId: conversation.id, amount: analysis.paidAmount,
            currency: agent.currency, status: 'paid', comment: 'Оплата по переписке',
            paidAt: moved ? movedAt : conversation.stageSetAt ?? movedAt }).returning({ id: orders.id });
          chatOrderId = order!.id;
        }
      }
```
Declare `let chatOrderId: string | null = null;` next to `let moved = false;`.
5. After `if (!applied) return 'skipped';`:
```ts
    // Reported like a Kaspi sale: an ad report, not a customer effect, so no live trigger is needed.
    if (chatOrderId) await queuePurchase(db, { agentId: agent.id, orderId: chatOrderId });
```
Add imports (`orders`, `kaspiPayments`, `inArray`, `queuePurchase`).

`turn.ts:737`: `canMoveToSuccess: () => hasVisiblePayment(db, agent.id, conversation.id),` (swap the import). `turn.ts:655` detail: `'Оплата в переписке не видна. Стадия продажи не изменена.'`. Check `simulator.ts` passes nothing or the same predicate (`grep -n canMoveToSuccess src`).

`leads.ts`: delete the `if (stage.kind === 'success' && !(await hasConfirmedKaspiPayment(...)))` block and the now-unused import. In the lead DTO (`:131-133`) accept `'paid'`:
```ts
      paymentEvidence:confirmed.length ? 'confirmed' : (['awaiting_payment','needs_verification','paid'].includes(crm?.profile.paymentEvidence ?? '') ? crm!.profile.paymentEvidence as 'awaiting_payment'|'needs_verification'|'paid' : 'unknown'),
```
and the same list for `paymentEvidenceReason`.

- [ ] **Step 4: Run the whole server suite**

Run: `cd server && npm run typecheck && npx vitest run` (sandbox disabled)
Expected: PASS (rerun the four known flaky files once before investigating).

- [ ] **Step 5: Commit**

```bash
git add server
git commit -m "feat(crm): move paid chats to the sale stage and record their order"
```

---

### Task 5: Orders list and cabinet labels

**Files:**
- Modify: `server/src/api/orders.ts:78-86`
- Modify: `rakurs/src/screens/OrdersScreen.tsx:31,41,43` (and its API type if `operationId` is typed non-null)
- Modify: `rakurs/src/components/lead/LeadPanel.tsx:568-571`
- Test: `server/test/orders-api.test.ts`

- [ ] **Step 1: Write the failing test**

In `orders-api.test.ts`, following the file's list test: insert a paid order with no Kaspi row (`comment: 'Оплата по переписке'`, `paidAt` set) and a pending order; `GET /api/agents/:id/orders` returns exactly the paid one with `operationId: null`. Keep the existing Kaspi-paid assertion.

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx vitest run test/orders-api.test.ts` (sandbox disabled) — Expected: FAIL (chat order missing).

- [ ] **Step 3: Implement**

`orders.ts` list query: `.leftJoin(kaspiPayments, eq(kaspiPayments.orderId, orders.id))` and
```ts
      .where(and(eq(orders.agentId, req.agent!.id), eq(orders.status, 'paid'),
        or(isNull(kaspiPayments.id), eq(kaspiPayments.status, 'paid'))))
```
Update the comment above the handlers: «only the provider confirms money received» → «money is confirmed by Kaspi or shown in the chat».

`OrdersScreen.tsx`: subtitle `Покупки с подтверждённой оплатой.`; empty state `Оплаченных заказов пока нет. Заказ появится здесь после оплаты через Kaspi или когда ИИ увидит оплату в переписке.`; verification cell:
```tsx
<td>{order.operationId ? <><span className="orders-verified">✓ Kaspi · оплачено</span><small>{order.operationId}</small></> : <span className="orders-verified">По переписке</span>}</td>
```

`LeadPanel.tsx`:
```ts
  const payment = crm?.paymentEvidence === 'confirmed' ? 'Подтверждена'
    : crm?.paymentEvidence === 'paid' ? 'Оплачено по переписке'
    : crm?.paymentEvidence === 'needs_verification' ? 'Требует проверки'
    : crm?.paymentEvidence === 'awaiting_payment' ? 'Ожидается'
    : 'Нет подтверждённых данных';
```

- [ ] **Step 4: Run checks**

Run: `cd server && npx vitest run test/orders-api.test.ts && npm run typecheck`; `cd rakurs && npx tsc --noEmit` (and `npm run build` if it exists).
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server rakurs
git commit -m "feat(orders): list chat-paid orders next to Kaspi ones"
```

