# Chat Payment Funnel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Started on: Opus 5 · Subtasks: Opus 5 (high) — the session model governs every subagent.

**Goal:** Merge «Заказано» into «Оплачено», let the CRM analysis move a lead into the sale stage when the chat shows payment, and record a paid order plus `Purchase` from the amount the seller quoted.

**Architecture:** The stage kind `awaiting_payment` disappears (contract, API, cabinet, default funnel, data migration). `lib/crm/analysis.ts` gains a grounded `paid` payment state and a grounded `paidAmount`; `lib/crm/worker.ts` uses them to move the lead and to insert one chat order, then calls the existing `queuePurchase`. The Kaspi-only gates in the operator move and the live reply agent go.

**Tech Stack:** TypeScript, Fastify, Drizzle ORM on Postgres, Zod, Vitest, React (cabinet `rakurs/`).

**Spec:** `docs/superpowers/specs/2026-09-14-chat-payment-funnel-design.md`

## Global Constraints

- Code, comments, tests, commits in English. User-facing strings in Russian.
- Match the surrounding code style of each file (several files are dense one-liners; keep them so).
- Sale stage = the one stage with `kind = 'success'`. Never create a second one.
- Chat order: `status = 'paid'`, `currency = agent.currency`, `comment = 'Оплата по переписке'`, `paidAt = conversations.stage_set_at`.
- Payment confidence threshold for moving: `confidence >= 65` (same as the existing stage threshold).
- New migration: `server/drizzle/0046_merge_awaiting_payment.sql`, journal entry `idx 46`, `when 1789295400000`. Never edit earlier migrations or journal entries.
- Test environment (every task): test DB is Docker (`docker compose -f deploy/compose.test.yml up -d`, port 55432, needs colima running). The Bash sandbox blocks localhost TCP, so every vitest run needs `dangerouslyDisableSandbox: true`; `connect EPERM 127.0.0.1:55432` means sandbox, not a dead DB. `npm install` in a fresh worktree needs `--cache "$TMPDIR/npm-cache"`. `capi-queue`, `session`, `whatsapp-inbound`, `knowledge-import-text` fail intermittently; rerun before investigating.
- Commit messages end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

---

### Task 1: Remove the `awaiting_payment` stage kind

**Files:**
- Modify: `packages/contract/index.ts:188` (StageKind), `:243` (paymentEvidence union)
- Modify: `server/src/api/stages.ts:13`
- Modify: `server/src/lib/funnel.ts:14-34`
- Modify: `server/src/db/schema.ts` comments at `:581` and `:705`
- Modify: `server/src/lib/capi/queue.ts:364` comment
- Modify: `rakurs/src/screens/FunnelSettings.tsx:24`, `rakurs/src/screens/StatsScreen.tsx:102-106`
- Test: `server/test/stages-api.test.ts`, `server/test/funnel-seed.test.ts`, `server/test/board-api.test.ts`, `server/test/stats-*.test.ts`, any other test naming «Заказано»

**Interfaces:**
- Produces: `StageKind = 'active' | 'qualified' | 'success' | 'failure'`; `Lead.crm.paymentEvidence: 'unknown' | 'awaiting_payment' | 'needs_verification' | 'paid' | 'confirmed'`; `DEFAULT_STAGES` with 8 entries.

- [ ] **Step 1: Write the failing tests**

In `server/test/stages-api.test.ts` add:

```ts
  it('refuses the removed awaiting_payment kind', async () => {
    const created = await app.inject({ method: 'POST', url: `/api/agents/${agentId}/stages`, cookies: jar,
      payload: { name: 'Ждёт оплаты', color: '#e0a13a', kind: 'awaiting_payment' } });
    expect(created.statusCode).toBe(400);
    const ready = await stageNamed('Готов к покупке');
    const patched = await app.inject({ method: 'PATCH', url: `/api/agents/${agentId}/stages/${ready.id}`, cookies: jar,
      payload: { kind: 'awaiting_payment' } });
    expect(patched.statusCode).toBe(400);
  });
```

In `server/test/funnel-seed.test.ts` assert the seeded names equal
`['Новый лид','В диалоге','Интерес проявлен','Квалифицирован','Предложение отправлено','Готов к покупке','Оплачено','Отказ']` (adapt to the file's existing assertion style).

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && npx vitest run test/stages-api.test.ts test/funnel-seed.test.ts` (sandbox disabled)
Expected: FAIL — 200 instead of 400; 9 names instead of 8.

- [ ] **Step 3: Implement**

`server/src/api/stages.ts`:
```ts
const KINDS = ['active', 'qualified', 'success', 'failure'] as const;
```
Check the PATCH/POST handlers answer a Zod failure with 400 (they do via `safeParse`; keep).

`server/src/lib/funnel.ts`: delete the `Заказано` entry; update the doc comment to «Eight stages … is quoted, and then either pays or does not.»

`packages/contract/index.ts`:
```ts
export type StageKind = 'active' | 'qualified' | 'success' | 'failure';
```
and in `Lead.crm`: `paymentEvidence: 'unknown' | 'awaiting_payment' | 'needs_verification' | 'paid' | 'confirmed';`

Schema comments: `// 'active' | 'qualified' | 'success' | 'failure'` at `:581`; at `:705` write `// 'active' | 'qualified' | 'success' | 'failure'; rows before migration 0046 may say 'awaiting_payment'`.

`capi/queue.ts:364`: «walks on from the qualifying stage into `success`».

`FunnelSettings.tsx`: remove the `{ id: 'awaiting_payment', label: 'Ждёт оплаты' }` line.

`StatsScreen.tsx`:
```ts
  kind === 'success'
    ? 'var(--accent)'
    : 'var(--accent-4)';
```

- [ ] **Step 4: Fix the tests that relied on «Заказано»**

Run `grep -rn "Заказано\|awaiting_payment" server/test`. For each hit that is a *stage* (not `paymentEvidence`):
- `stages-api.test.ts:125` promote `Готов к покупке` instead of `Заказано`.
- `board-api.test.ts:153,163` drop `Заказано` from the expected column list; use `Готов к покупке` where a non-sale stage is needed.
- `stats-period.test.ts`, `stats-record.test.ts`: replace `Заказано` in walks/expectations with `Готов к покупке`, recomputing the expected counts and ratios from the walk (a walk must not list the same stage twice).
- `crm-analysis.test.ts` stage fixture is rewritten in Task 3; leave it.

- [ ] **Step 5: Run server and cabinet checks**

Run: `cd server && npm run typecheck && npx vitest run` (sandbox disabled); `cd rakurs && npx tsc --noEmit`.
Expected: type errors only in `server/src/lib/crm/analysis.ts` / `crm-analysis.test.ts` if any reference the removed kind (those are Task 3) — otherwise PASS. If `analysis.ts` fails to compile, change only the `resolveCrmStage` fallback line to `return target.kind === 'success' ? null : target;` so the suite runs; Task 3 replaces it.

- [ ] **Step 6: Commit**

```bash
git add -A packages server rakurs
git commit -m "feat(funnel): drop the awaiting_payment stage kind"
```

---

### Task 2: Migration 0046 merges existing awaiting_payment stages

**Files:**
- Create: `server/drizzle/0046_merge_awaiting_payment.sql`
- Modify: `server/drizzle/meta/_journal.json` (append entry)
- Test: `server/test/funnel-merge-migration.test.ts`

**Interfaces:**
- Consumes: `tagsBefore`, `runMigration`, `ADMIN_URL`, `withDatabase` from `server/test/helpers/migration-db.ts` (see `knowledge-vault-migration.test.ts` for usage).

- [ ] **Step 1: Write the failing test**

Create `server/test/funnel-merge-migration.test.ts` on a disposable database, following `knowledge-vault-migration.test.ts`: apply `tagsBefore('0046_merge_awaiting_payment')`, seed, run the target, assert, drop the database in `afterAll`.

Seed (read column requirements from `server/src/db/schema.ts` — insert only NOT NULL columns without defaults):
- account + agent A with stages: `Новый лид` active p0, `Готов к покупке` active p1, `Заказано` awaiting_payment p2, `Оплачено` success p3, `Отказ` failure p4;
- two contacts + conversations in `Заказано`, one conversation in `Новый лид`;
- a `crm_analyses` row for one `Заказано` conversation with `analyzed_message_id` set to a real message id and `status = 'ready'`;
- agent B with only `Ждёт` awaiting_payment p0 and `Новый` active p1 (no success stage), one conversation in `Ждёт`.

Assertions:
```ts
    // agent A
    expect(stageNamesA).toEqual(['Новый лид', 'Готов к покупке', 'Оплачено', 'Отказ']);
    expect(positionsA).toEqual([0, 1, 2, 3]);
    expect(movedConversations.every((c) => c.stage_id === saleIdA && c.stage_set_by === 'system')).toBe(true);
    expect(untouched.stage_id).toBe(newLeadIdA);
    expect(transitionsA).toHaveLength(2);
    expect(transitionsA[0]).toMatchObject({ from_name: 'Заказано', to_name: 'Оплачено', to_kind: 'success', moved_by: 'system' });
    expect(analysis).toMatchObject({ analyzed_message_id: null, status: 'pending', lease_token: null });
    // agent B keeps its lead and the stage becomes active
    expect(stageB).toMatchObject({ name: 'Ждёт', kind: 'active' });
    expect(conversationB.stage_id).toBe(stageB.id);
    expect(await sql`select 1 from stages where kind = 'awaiting_payment'`).toHaveLength(0);
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx vitest run test/funnel-merge-migration.test.ts` (sandbox disabled)
Expected: FAIL — unknown tag / missing file.

- [ ] **Step 3: Write the migration**

`server/drizzle/0046_merge_awaiting_payment.sql`:
```sql
-- Merge every awaiting_payment stage into its agent's sale stage.
-- See docs/superpowers/specs/2026-09-14-chat-payment-funnel-design.md.
INSERT INTO stage_transitions (agent_id, conversation_id, from_stage_id, to_stage_id, from_name, to_name, to_kind, from_position, to_position, moved_by, occurred_at)
SELECT c.agent_id, c.id, a.id, s.id, a.name, s.name, s.kind, a.position, s.position, 'system', now()
FROM conversations c
JOIN stages a ON a.id = c.stage_id AND a.kind = 'awaiting_payment'
JOIN stages s ON s.agent_id = a.agent_id AND s.kind = 'success';
--> statement-breakpoint
UPDATE crm_analyses ca SET analyzed_message_id = NULL, status = 'pending', lease_token = NULL, lease_until = NULL, updated_at = now()
FROM conversations c
JOIN stages a ON a.id = c.stage_id AND a.kind = 'awaiting_payment'
JOIN stages s ON s.agent_id = a.agent_id AND s.kind = 'success'
WHERE ca.conversation_id = c.id;
--> statement-breakpoint
UPDATE conversations c SET stage_id = s.id, stage_set_at = now(), stage_set_by = 'system'
FROM stages a
JOIN stages s ON s.agent_id = a.agent_id AND s.kind = 'success'
WHERE c.stage_id = a.id AND a.kind = 'awaiting_payment';
--> statement-breakpoint
UPDATE stages SET kind = 'active'
WHERE kind = 'awaiting_payment'
  AND NOT EXISTS (SELECT 1 FROM stages s WHERE s.agent_id = stages.agent_id AND s.kind = 'success');
--> statement-breakpoint
DELETE FROM stages WHERE kind = 'awaiting_payment';
--> statement-breakpoint
UPDATE stages SET position = r.pos
FROM (SELECT id, (row_number() OVER (PARTITION BY agent_id ORDER BY position, id) - 1)::int AS pos FROM stages) r
WHERE stages.id = r.id AND stages.position <> r.pos;
```
Verify column names against `schema.ts` (`stage_set_by`, `lease_token`, `updated_at` on `crm_analyses`) before running.

Append to `_journal.json` entries:
```json
    {
      "idx": 46,
      "version": "7",
      "when": 1789295400000,
      "tag": "0046_merge_awaiting_payment",
      "breakpoints": true
    }
```
No snapshot file: the migration changes data, not schema.

- [ ] **Step 4: Run tests**

Run: `cd server && npx vitest run test/funnel-merge-migration.test.ts test/migration-journal.test.ts` (sandbox disabled)
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/drizzle server/test/funnel-merge-migration.test.ts
git commit -m "feat(funnel): migrate awaiting_payment stages into the sale stage"
```

---

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

---

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

---

## After the tasks

- Full `server` suite + cabinet type check once more on the final branch.
- Push the branch and open a PR. Release to production goes through `deploy/release.sh` from `origin/main` only after the owner approves the merge.
- After release, check on production: no `awaiting_payment` stages, the 20 leads in «Оплачено», their `crm_analyses` drained, and how many got a chat order. The CRM worker only drains conversations its mode allows (`independent`, or `follow_ai` with AI on and live mode) — if the agent is not eligible, report it rather than changing the mode.
