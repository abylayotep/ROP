# Drafts and Test Runs — Part 1: the store and the operations

> Part of [the drafts plan](2026-09-08-drafts-and-test-runs.md). Read its header and **Global Constraints** before starting, and use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to work through the tasks. Steps use checkbox (`- [ ]`) syntax.

**Spec:** [docs/superpowers/specs/2026-09-08-drafts-and-test-runs-design.md](../specs/2026-09-08-drafts-and-test-runs-design.md)

---

### Task 1: Drafts, cases, runs and results in the schema

**Files:**
- Create: `server/src/lib/drafts/ops.ts` (types only)
- Modify: `server/src/db/schema.ts` (add four tables, `agents.configVersion`, `coachMessages.draftId`)
- Modify: `server/test/helpers/db.ts` (truncate list)
- Create: `server/drizzle/0014_*.sql` (generated)
- Test: `server/test/drafts-schema.test.ts`

**Interfaces:**
- Produces: `kbDrafts`, `testCases`, `testRuns`, `testResults`, and the two types the schema's `jsonb` columns are branded with — `DraftOp` and `DraftBase` in a new `server/src/lib/drafts/ops.ts`. The file holds **only the types** at this task; Task 3 adds the functions to it.

- [ ] **Step 1: Write the failing test**

```ts
// server/test/drafts-schema.test.ts
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { agents, kbDrafts, testCases, testResults, testRuns } from '../src/db/schema.js';
import { createAccountWithOwner } from '../src/lib/provision.js';
import { withDb } from './helpers/db.js';

let db: Awaited<ReturnType<typeof withDb>>;
let agentId: string;

beforeEach(async () => {
  db = await withDb();
  ({ agentId } = await createAccountWithOwner(db, {
    company: 'Сафина', email: 'owner@example.com', password: 'correct-horse-battery',
  }));
});

const draft = () => db.insert(kbDrafts).values({
  agentId, title: 'Не обещать скидку', origin: 'coach', status: 'open',
  ops: [{ op: 'rule_create', category: 'forbid', text: 'Не обещай скидку.' }], base: {},
}).returning();

describe('the drafts schema', () => {
  it('starts an agent at config version 1', async () => {
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(agent!.configVersion).toBe(1);
  });

  it('opens a draft with its operations', async () => {
    const [row] = await draft();
    expect(row!.status).toBe('open');
    expect(row!.ops[0]!.op).toBe('rule_create');
    expect(row!.appliedAt).toBeNull();
  });

  it('takes a run with no draft as a baseline', async () => {
    const [run] = await db.insert(testRuns).values({
      agentId, draftId: null, configVersion: 1, model: 'openai/gpt-4o-mini', status: 'done',
    }).returning();
    expect(run!.draftId).toBeNull();
  });

  it('holds one result per case in a run', async () => {
    const [row] = await draft();
    const [run] = await db.insert(testRuns).values({
      agentId, draftId: row!.id, configVersion: 1, model: 'openai/gpt-4o-mini', status: 'done',
    }).returning();
    const [kase] = await db.insert(testCases).values({
      agentId, title: 'Про доставку', messages: ['сколько стоит доставка'], origin: 'manual',
    }).returning();
    const values = { runId: run!.id, caseId: kase!.id, reply: '1500 ₸.', usedChunkIds: [],
      handoff: false, outcome: 'unrecorded' };
    await db.insert(testResults).values(values);
    await expect(db.insert(testResults).values(values)).rejects.toThrow();
  });

  it('deletes runs and results with the draft', async () => {
    const [row] = await draft();
    await db.insert(testRuns).values({
      agentId, draftId: row!.id, configVersion: 1, model: 'openai/gpt-4o-mini', status: 'done' });
    await db.delete(kbDrafts).where(eq(kbDrafts.id, row!.id));
    expect(await db.select().from(testRuns)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from `server/`: `npx vitest run test/drafts-schema.test.ts`
Expected: FAIL — `kbDrafts` is not exported from the schema.

- [ ] **Step 3: Write the operation types**

```ts
// server/src/lib/drafts/ops.ts — types now, the functions that use them in Task 3.
import type { RuleCategory } from '../ai/rules.js';

/** One write a draft would make. A note operation goes through the editor's own save path. */
export type DraftOp =
  | { op: 'note_create'; path: string; body: string }
  | { op: 'note_update'; noteId: string; body: string }
  | { op: 'rule_create'; category: RuleCategory; text: string; warning?: string | null }
  | { op: 'rule_update'; ruleId: string; text?: string; enabled?: boolean };

/**
 * The `updatedAt` of everything the ops touch, as ISO strings, taken when the draft was made.
 *
 * A draft is a promise that what was tested is what lands. This is how the promise is checked:
 * a note edited underneath the draft makes it false, and applying anyway would put an untested
 * change into the store the agent answers from.
 */
export interface DraftBase {
  notes?: Record<string, string>;
  rules?: Record<string, string>;
}
```

- [ ] **Step 4: Write the tables**

Add to `server/src/db/schema.ts`, and add `configVersion: integer('config_version').notNull().default(1)` to `agents` with this comment:

```ts
    // What the agent would say, versioned. Every write that changes an answer — a note, an
    // import, a rule, an applied draft — bumps it, and a test run records the version it ran
    // at. That is what lets «было» be reused across runs and what makes a draft tested against
    // a store that has since moved refuse to apply.
```

```ts
/**
 * One change, waiting to be proven.
 *
 * `ops` is what would be written; `base` is the `updatedAt` of everything the ops touch, taken
 * when the draft was made. Applying compares the two, because a draft is a promise that what
 * was tested is what lands, and a note edited underneath it makes that promise false.
 */
export const kbDrafts = pgTable(
  'kb_drafts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    // 'coach' | 'manual'
    origin: text('origin').notNull(),
    // 'open' | 'applied' | 'discarded'
    status: text('status').notNull().default('open'),
    ops: jsonb('ops').$type<DraftOp[]>().notNull(),
    base: jsonb('base').$type<DraftBase>().notNull().default({}),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
  },
  (t) => [index('kb_drafts_agent_status_idx').on(t.agentId, t.status, t.createdAt)],
);

/**
 * One conversation to replay. `messages` is the customer's side only — the agent's replies are
 * what is being tested, and storing them here would be storing the answer in the question.
 */
export const testCases = pgTable(
  'test_cases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    messages: jsonb('messages').$type<string[]>().notNull(),
    // What the owner expects, in words. Read by a person and by the annotating model, never
    // asserted on: turning it into an assertion is a feature with its own grammar.
    expectation: text('expectation'),
    // 'manual' | 'dialog' | 'generated'
    origin: text('origin').notNull().default('manual'),
    conversationId: uuid('conversation_id').references(() => conversations.id, { onDelete: 'set null' }),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('test_cases_agent_enabled_idx').on(t.agentId, t.enabled)],
);

/** One pass over a set of cases. `draftId` null is a baseline: the store as it stands. */
export const testRuns = pgTable(
  'test_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
    draftId: uuid('draft_id').references(() => kbDrafts.id, { onDelete: 'cascade' }),
    // The agent's version at the moment the run started. A baseline is reusable only at the
    // same version and the same model.
    configVersion: integer('config_version').notNull(),
    model: text('model').notNull(),
    // 'running' | 'done' | 'failed'
    status: text('status').notNull().default('running'),
    cost: numeric('cost', { precision: 12, scale: 8 }).notNull().default('0'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [index('test_runs_agent_draft_idx').on(t.agentId, t.draftId, t.startedAt),
          index('test_runs_baseline_idx').on(t.agentId, t.configVersion)],
);

/** What one case produced in one run, and what the annotating model thought of it. */
export const testResults = pgTable(
  'test_results',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id').notNull().references(() => testRuns.id, { onDelete: 'cascade' }),
    caseId: uuid('case_id').notNull().references(() => testCases.id, { onDelete: 'cascade' }),
    reply: text('reply'),
    usedChunkIds: jsonb('used_chunk_ids').$type<string[]>().notNull().default([]),
    stageId: uuid('stage_id'),
    handoff: boolean('handoff').notNull().default(false),
    handoffReason: text('handoff_reason'),
    // The `TurnOutcome` the replay ended in.
    outcome: text('outcome').notNull(),
    cost: numeric('cost', { precision: 12, scale: 8 }).notNull().default('0'),
    // 'better' | 'worse' | 'same', or null when the annotation did not run or failed. A hint
    // in a column: it gates nothing.
    verdict: text('verdict'),
    verdictReason: text('verdict_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('test_results_run_case_key').on(t.runId, t.caseId)],
);
```

Add `draftId: uuid('draft_id').references(() => kbDrafts.id, { onDelete: 'set null' })` to
`coachMessages` — the column the coaching spec described and this migration is the first that
can create. `stageId` is a plain `uuid` with no reference: a run records the stage a rolled-back
turn *would* have moved to, and a foreign key would be pointing from surviving data at a row
that may later be deleted.

- [ ] **Step 5: Generate the migration and add the tables to the truncate list**

Run: `npm run generate`. No hand-editing is needed — there is no data to move. In
`server/test/helpers/db.ts`, add `test_results, test_runs, test_cases, kb_drafts` before
`agents`.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/drafts-schema.test.ts test/schema.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src/lib/drafts/ops.ts server/src/db/schema.ts server/drizzle server/test
git commit -m "Store drafts, cases, runs and their results"
```

---

### Task 2: The config version

**Files:**
- Create: `server/src/lib/drafts/version.ts`
- Modify: `server/src/api/knowledge.ts`, `server/src/api/rules.ts` (call it)
- Test: `server/test/config-version.test.ts`

**Interfaces:**
- Produces: `export async function bumpConfigVersion(tx: Db, agentId: string): Promise<number>` — returns the new version.

- [ ] **Step 1: Write the failing test**

```ts
// server/test/config-version.test.ts
const version = async () => (await db.select({ v: agents.configVersion })
  .from(agents).where(eq(agents.id, agentId)))[0]!.v;

it('moves when a note is written, renamed or deleted', async () => {
  const before = await version();
  const res = await app.inject({ method: 'POST', url: notes(), cookies: jar,
    payload: { path: 'Доставка', body: '1500 ₸.' } });
  expect(await version()).toBe(before + 1);
  await app.inject({ method: 'PATCH', url: `${notes()}/${res.json().id}`, cookies: jar,
    payload: { body: '1600 ₸.' } });
  expect(await version()).toBe(before + 2);
  await app.inject({ method: 'DELETE', url: `${notes()}/${res.json().id}`, cookies: jar });
  expect(await version()).toBe(before + 3);
});

it('moves when a rule is created, edited, switched or deleted', async () => {
  const before = await version();
  const rule = (await app.inject({ method: 'POST', url: rules(), cookies: jar,
    payload: { category: 'tone', text: 'На «вы».' } })).json();
  expect(await version()).toBe(before + 1);
  await app.inject({ method: 'PATCH', url: `${rules()}/${rule.id}`, cookies: jar,
    payload: { text: 'Только на «вы».' } });
  expect(await version()).toBe(before + 2);
  await app.inject({ method: 'PATCH', url: `${rules()}/${rule.id}`, cookies: jar,
    payload: { enabled: false } });
  expect(await version()).toBe(before + 3);
  await app.inject({ method: 'DELETE', url: `${rules()}/${rule.id}`, cookies: jar });
  expect(await version()).toBe(before + 4);
});

it('moves when a page is imported and when it is refreshed', async () => {
  const before = await version();
  const source = await importPage('<h1>Двери</h1><p>80 000 ₸.</p>');
  expect(await version()).toBe(before + 1);
  await app.inject({ method: 'POST', cookies: jar,
    url: `${sources()}/${source.json().source.id}/refresh` });
  expect(await version()).toBe(before + 2);
});
it('does not move on a read', async () => {
  const before = await version();
  await app.inject({ method: 'GET', url: notes(), cookies: jar });
  await app.inject({ method: 'GET', url: `${notes()}?q=доставка`, cookies: jar });
  expect(await version()).toBe(before);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/config-version.test.ts`
Expected: FAIL — the version never moves.

- [ ] **Step 3: Write it and wire it in**

```ts
import { eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { agents } from '../../db/schema.js';

/**
 * Mark that this agent would now answer differently.
 *
 * Called inside the same transaction as the write it describes, never after it: a version that
 * lags its data is worse than no version at all, because it makes a stale baseline look fresh
 * and a draft tested against yesterday's store look proven.
 */
export async function bumpConfigVersion(tx: Db, agentId: string): Promise<number> {
  const [row] = await tx
    .update(agents)
    .set({ configVersion: sql`${agents.configVersion} + 1` })
    .where(eq(agents.id, agentId))
    .returning({ version: agents.configVersion });
  return row!.version;
}
```

Call it in the same transaction as: every note create, update and delete; every source import,
refresh and delete; every rule create, update and delete. Nowhere else.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/config-version.test.ts` then `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src server/test/config-version.test.ts
git commit -m "Version what the agent would say"
```

---

### Task 3: Applying a draft's operations

**Files:**
- Create: `server/src/lib/drafts/ops.ts`
- Test: `server/test/draft-ops.test.ts`

**Interfaces:**
- Consumes: `saveNote`, `deleteNote`, `agentRules`, and the `DraftOp` / `DraftBase` types Task 1 put in this same file.
- Produces:
  - `export async function applyOps(tx: Db, agentId: string, ops: DraftOp[]): Promise<void>`
  - `export async function baseOf(db: Db, agentId: string, ops: DraftOp[]): Promise<DraftBase>`
  - `export async function staleOps(db: Db, agentId: string, ops: DraftOp[], base: DraftBase): Promise<string[]>` — the human-readable names of what has moved, empty when nothing has.

- [ ] **Step 1: Write the failing test**

```ts
// server/test/draft-ops.test.ts
it('creates a note with its sections', async () => {
  await applyOps(db, agentId, [{ op: 'note_create', path: 'Доставка', body: '## По городу\n1500 ₸.' }]);
  const [chunk] = await db.select().from(kbChunks).where(eq(kbChunks.agentId, agentId));
  expect(chunk!.title).toBe('Доставка › По городу');
});

it('creates a rule at the end of its category', async () => {
  await applyOps(db, agentId, [{ op: 'rule_create', category: 'forbid', text: 'Не обещай скидку.' }]);
  const [rule] = await db.select().from(agentRules).where(eq(agentRules.agentId, agentId));
  expect(rule!.origin).toBe('coach');
});

it('takes the updatedAt of everything the ops touch', async () => {
  const note = await saveNote(db, { agentId, path: 'Доставка', body: '1500 ₸.' });
  const base = await baseOf(db, agentId, [{ op: 'note_update', noteId: note.id, body: '1600 ₸.' }]);
  expect(base.notes![note.id]).toBe(note.updatedAt.toISOString());
});

it('names a note that moved since the base was taken', async () => {
  const note = await saveNote(db, { agentId, path: 'Доставка', body: '1500 ₸.' });
  const ops = [{ op: 'note_update' as const, noteId: note.id, body: '1600 ₸.' }];
  const base = await baseOf(db, agentId, ops);
  await saveNote(db, { agentId, noteId: note.id, path: 'Доставка', body: '1700 ₸.' });
  expect(await staleOps(db, agentId, ops, base)).toEqual(['Доставка']);
});

it('names a note that was deleted since the base was taken', async () => {
  const note = await saveNote(db, { agentId, path: 'Доставка', body: '1500 ₸.' });
  const ops = [{ op: 'note_update' as const, noteId: note.id, body: '1600 ₸.' }];
  const base = await baseOf(db, agentId, ops);
  await deleteNote(db, agentId, note.id);
  expect(await staleOps(db, agentId, ops, base)).toEqual(['Доставка']);
});

it('says nothing is stale when nothing moved', async () => {
  const ops = [{ op: 'rule_create' as const, category: 'tone' as const, text: 'На «вы».' }];
  expect(await staleOps(db, agentId, ops, await baseOf(db, agentId, ops))).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/draft-ops.test.ts`
Expected: FAIL — unresolved import.

- [ ] **Step 3: Write `ops.ts`**

`applyOps` walks the list in order, calling `saveNote` for the two note operations — the same
path the editor uses, so chunks and links are rebuilt exactly as they would be — and inserting
or updating `agentRules` with `origin: 'coach'` for the two rule operations. It does **not** bump
the version: a run applies ops inside a transaction it throws away, and a bump there would be a
write the rollback happens to cover rather than a write we never made. The apply route bumps.

`baseOf` reads the `updatedAt` of every note and rule an op names. `staleOps` re-reads them and
returns the path or the rule text of each one whose `updatedAt` differs or which is now missing.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/draft-ops.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/lib/drafts server/test/draft-ops.test.ts
git commit -m "Apply a draft's operations, and notice when its base has moved"
```

---

