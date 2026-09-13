# Chat Payment Funnel — Task 3 (CRM analysis)

> Part of `2026-09-14-chat-payment-funnel.md` — read its header and Global Constraints first; they apply to every task here.

### Task 3: Grounded `paid` state and `paidAmount` in the CRM analysis

**Files:**
- Modify: `server/src/lib/crm/analysis.ts`
- Test: `server/test/crm-analysis.test.ts`

**Interfaces:**
- Produces:
  - `CrmAnalysis.payment: { state: 'unknown' | 'awaiting_payment' | 'needs_verification' | 'paid'; reason: string; messageId: string } | null`
  - `CrmAnalysis.paidAmount: string | null` (plain digits)
  - `resolveCrmStage<T extends CrmStage>(stages: T[], requested: string | null, input: { paid: boolean; currentStageId: string | null }): T | null`
  - `resolvePaymentEvidence(previousState, previousReason, current, confirmed)` now returns state `'paid'` too, sticky.

- [ ] **Step 1: Rewrite the stage fixture and write failing tests**

Fixture at the top of `crm-analysis.test.ts`:
```ts
const stages = [
  { id: 'new', name: 'Новый лид', kind: 'active', position: 0 },
  { id: 'ready', name: 'Готов к покупке', kind: 'active', position: 1 },
  { id: 'paid', name: 'Оплачено', kind: 'success', position: 2 },
];
const output = (patch = {}) => JSON.stringify({ stageId: 'ready', summary: 'Заказал фильтры', confidence: 95,
  profile: { name: proof('Айгуль'), city: proof('Алматы') }, fields: {}, checkout: null, ...patch });
```
Replace every `resolveCrmStage(stages, X, bool)` call: `resolveCrmStage(stages, X, { paid: bool, currentStageId: null })`, and every expected `'ordered'` with `null` where the request was `'paid'` without payment (the lead stays put) and with `'ready'` where the request was `'ordered'`.

New tests:
```ts
it('moves to the sale stage only on payment and never out of it', () => {
  const none = { paid: false, currentStageId: null };
  expect(resolveCrmStage(stages, 'paid', none)).toBeNull();
  expect(resolveCrmStage(stages, 'ready', none)?.id).toBe('ready');
  expect(resolveCrmStage(stages, 'ready', { paid: true, currentStageId: 'new' })?.id).toBe('paid');
  expect(resolveCrmStage(stages, 'new', { paid: false, currentStageId: 'paid' })).toBeNull();
});

it('accepts a client transfer claim as paid', () => {
  const client = { id: 'c1', author: 'client', kind: 'text', body: 'Добрый день, перевела 6990 на Kaspi' };
  const result = parseCrmAnalysis(output({ payment: { state: 'paid', messageId: 'c1', quote: 'перевела 6990', reason: 'Клиент перевёл оплату' } }), [client], []);
  expect(result.payment).toEqual({ state: 'paid', messageId: 'c1', reason: 'Клиент перевёл оплату' });
});

it('accepts a seller receipt confirmation as paid but not payment instructions', () => {
  const thanks = { id: 's1', author: 'phone', kind: 'text', body: 'Спасибо, оплату получили!' };
  const requisites = { id: 's2', author: 'operator', kind: 'text', body: 'Kaspi перевод +77066241022, Құралай А.' };
  const paid = (messageId: string, quote: string) => ({ payment: { state: 'paid', messageId, quote, reason: 'Продавец подтвердил' } });
  expect(parseCrmAnalysis(output(paid('s1', 'оплату получили')), [thanks], []).payment?.state).toBe('paid');
  expect(parseCrmAnalysis(output(paid('s2', 'Kaspi перевод')), [requisites], []).payment).toBeNull();
});

it('rejects paid on a negated claim and downgrades an attachment to verification', () => {
  const negated = { id: 'n1', author: 'client', kind: 'text', body: 'Ещё не оплатила, вечером' };
  expect(parseCrmAnalysis(output({ payment: { state: 'paid', messageId: 'n1', quote: 'не оплатила', reason: 'x' } }), [negated], []).payment).toBeNull();
  const photo = { id: 'p1', author: 'client', kind: 'image', mediaMime: 'image/jpeg', body: 'оплатила' };
  expect(parseCrmAnalysis(output({ payment: { state: 'paid', messageId: 'p1', quote: 'оплатила', reason: 'Чек' } }), [photo], []).payment)
    .toEqual({ state: 'needs_verification', messageId: 'p1', reason: 'Вложение требует проверки' });
});

it('grounds the paid amount in a seller price message', () => {
  const offer = { id: 'o1', author: 'phone', kind: 'text', body: 'Стандартный размер 40 мм — 6.990 тенге' };
  const client = { id: 'c1', author: 'client', kind: 'text', body: 'Беру за 6990' };
  const amount = (messageId: string, value: string, quote: string) => ({ paidAmount: { value, messageId, quote } });
  expect(parseCrmAnalysis(output(amount('o1', '6990', '6.990 тенге')), [offer, client], []).paidAmount).toBe('6990');
  expect(parseCrmAnalysis(output(amount('o1', '699', '6.990 тенге')), [offer, client], []).paidAmount).toBeNull();
  expect(parseCrmAnalysis(output(amount('c1', '6990', 'за 6990')), [offer, client], []).paidAmount).toBeNull();
  expect(parseCrmAnalysis(output(amount('o1', '6990', '7 000 тенге')), [offer, client], []).paidAmount).toBeNull();
  expect(parseCrmAnalysis(output(amount('o1', '1200000', '1 200 000')), [{ ...offer, body: 'Итого 1 200 000 ₸' }], []).paidAmount).toBe('1200000');
});

it('keeps paid evidence until Kaspi confirms or a new paid reason arrives', () => {
  expect(resolvePaymentEvidence('paid', 'Клиент перевёл', null, false)).toEqual({ state: 'paid', reason: 'Клиент перевёл' });
  expect(resolvePaymentEvidence('paid', 'Клиент перевёл', { state: 'unknown', reason: 'нет данных', messageId: 'm' }, false))
    .toEqual({ state: 'paid', reason: 'Клиент перевёл' });
  expect(resolvePaymentEvidence('paid', 'Клиент перевёл', null, true).state).toBe('confirmed');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && npx vitest run test/crm-analysis.test.ts`
Expected: FAIL (signature, `paidAmount` undefined, `paid` rejected by the enum).

- [ ] **Step 3: Implement in `analysis.ts`**

Schema:
```ts
  payment: z.object({
    state: z.enum(['unknown', 'awaiting_payment', 'needs_verification', 'paid']),
    messageId: z.string(), quote: z.string().trim().max(1000).default(''), reason: z.string().trim().min(1).max(300),
  }).nullable().default(null).catch(null),
  paidAmount: z.object({ value: z.string().regex(/^\d{1,9}$/), messageId: z.string(), quote: z.string().trim().min(1).max(1000) })
    .nullable().default(null).catch(null),
```
`CrmAnalysis`: add `'paid'` to `payment.state`, add `paidAmount: string | null`.

Helpers next to the existing regexes:
```ts
const SELLER = ['phone', 'operator', 'ai'];
const clientPaid = /(?:оплатил[аи]?|оплачено|перев[её]л[аи]?|перевели|скинул[аи]?|отправил[аи]? (?:деньги|оплату)|аудардым|төледім|төлеп қойдым)/iu;
// «пришли» but not «пришлите»: a seller asking for a receipt has not received money.
const sellerReceived = /(?:получил[аи]?|пришла|пришли(?!те)|поступил[аи]?|оплачено|алдық|түсті|қабылдадық)/iu;
const negated = /(?:^|[^а-яёәіңғүұқөһa-z])(?:не|ещё не|еще не|пока не)\s+\S*|жоқ|емес/iu;
/** Digit groups joined: «6.990» → «6990», «1 200 000» → «1200000». */
const numbersIn = (text: string) => text.replace(/(\d)[\s .,](?=\d{3}(?!\d))/g, '$1').match(/\d+/g) ?? [];
```
Payment block:
```ts
  let payment: CrmAnalysis['payment'] = null;
  if (result.payment) {
    const { state, quote } = result.payment;
    const source = messages.get(result.payment.messageId);
    const quoted = !!source && source.kind !== 'unsupported' && !!quote && !!source.body?.includes(quote);
    const attachment = source?.author === 'client' && !!source.kind && source.kind !== 'text'
      && (!!source.mediaMime || ['image', 'document', 'unsupported'].includes(source.kind));
    const paidClaim = state === 'paid' && quoted && source?.author === 'client' && clientPaid.test(quote) && !negated.test(quote);
    const paidReceipt = state === 'paid' && quoted && SELLER.includes(source!.author) && sellerReceived.test(quote) && !negated.test(quote);
    const groundedText = state !== 'paid' && source?.author === 'client' && quoted;
    const unreadAttachment = attachment && (state === 'needs_verification' || state === 'paid');
    if (unreadAttachment) payment = { state: 'needs_verification', reason: 'Вложение требует проверки', messageId: result.payment.messageId };
    else if (paidClaim || paidReceipt || groundedText) payment = { state, reason: result.payment.reason, messageId: result.payment.messageId };
  }
  let paidAmount: string | null = null;
  if (result.paidAmount) {
    const source = messages.get(result.paidAmount.messageId);
    const { value, quote } = result.paidAmount;
    if (source && SELLER.includes(source.author) && source.body?.includes(quote) && Number(value) > 0
      && numbersIn(quote).includes(value)) paidAmount = value;
  }
```
Keep the old behaviour of the existing tests: a `needs_verification` claim quoted from a client *captioned* attachment still becomes «Вложение требует проверки»; a quote from an `unsupported` placeholder with state `awaiting_payment` stays `null` (`quoted` is false for `unsupported`, `attachment` true but state is not verification/paid). Run the old tests to confirm.

Return `paidAmount` in the result object.

`resolvePaymentEvidence`:
```ts
  if (confirmed) return { state: 'confirmed' as const, reason: 'Оплата подтверждена Kaspi POS.' };
  if (current?.state === 'paid') return { state: 'paid' as const, reason: current.reason };
  if (previousState === 'paid') return { state: 'paid' as const, reason: previousReason ?? null };
  if (current) return { state: current.state, reason: current.reason };
```
(rest unchanged).

`resolveCrmStage`:
```ts
/** The sale stage is entered only on payment, and the analysis never takes a lead out of it. */
export function resolveCrmStage<T extends CrmStage>(stages: T[], requested: string | null,
  input: { paid: boolean; currentStageId: string | null }): T | null {
  if (stages.find((s) => s.id === input.currentStageId)?.kind === 'success') return null;
  if (input.paid) return stages.find((s) => s.kind === 'success') ?? null;
  const target = stages.find((s) => s.id === requested);
  return !target || target.kind === 'success' ? null : target;
}
```

Prompt (`crmPrompt`) — replace these lines, keep the rest verbatim:
- `'Classify by actual conversion progress using the provided stage descriptions. Agreeing to order is not a sale: choose the success stage only when the conversation shows the payment happened.'`
- `'Payment is visible when the customer says they paid or sent a transfer, or the seller confirms the money arrived. A receipt photo alone is not proof: attachment contents cannot be read.'`
- `'When the customer agrees to a specific order but payment is not visible, choose the latest fitting non-success stage, never the success stage.'`
- `'Return payment as unknown, awaiting_payment, needs_verification or paid. paid needs a verbatim quote of the customer saying they paid or the seller confirming receipt; an unread attachment alone is needs_verification. Never return confirmed.'`
- add: `'paidAmount only when payment is visible: {value,messageId,quote}, value = plain digits of the total the seller quoted for this order (6.990 тенге → "6990"), quote verbatim from that seller message. Otherwise null.'`
- JSON line: `payment:null|{state:"unknown"|"awaiting_payment"|"needs_verification"|"paid",messageId,quote,reason},paidAmount:null|{value,messageId,quote},checkout:…`

- [ ] **Step 4: Run tests**

Run: `cd server && npx vitest run test/crm-analysis.test.ts`
Expected: PASS. `npm run typecheck` will now fail in `worker.ts` (Task 4) — expected.

- [ ] **Step 5: Commit**

```bash
git add server/src/lib/crm/analysis.ts server/test/crm-analysis.test.ts
git commit -m "feat(crm): ground chat payment and the quoted amount"
```

