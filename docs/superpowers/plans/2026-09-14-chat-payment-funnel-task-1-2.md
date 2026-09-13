# Chat Payment Funnel — Tasks 1–2 (stage kind, migration)

> Part of `2026-09-14-chat-payment-funnel.md` — read its header and Global Constraints first; they apply to every task here.

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

