import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client.js';
import { accounts, agents, kbDrafts, testCases, testResults, testRuns } from '../src/db/schema.js';
import { baselineResults } from '../src/lib/drafts/baseline.js';
import { withDb } from './helpers/db.js';

// Same direct-insert pattern as `knowledge-vault-schema.test.ts` and `drafts-schema.test.ts`:
// `createAccountWithOwner` takes a password and returns `{ accountId, userId }`, not an agent —
// a schema-level test only needs a row to hang a foreign key off.
async function seedAgent(db: Db, name = 'Сафина') {
  const [account] = await db.insert(accounts).values({ name }).returning();
  const [agent] = await db.insert(agents).values({ accountId: account!.id, name }).returning();
  return agent!.id;
}

let db: Db;
let agentId: string;

beforeEach(async () => {
  db = await withDb();
  agentId = await seedAgent(db);
});

/** A case to run against, scoped to `agentId`. */
async function addCase(title: string) {
  const [row] = await db
    .insert(testCases)
    .values({ agentId, title, messages: [title], origin: 'manual' })
    .returning();
  return row!;
}

/**
 * Records a run of `caseId` with no draft — the shape a baseline actually has: `draft_id`
 * null, because it is the agent answering as it stands, not a draft being measured.
 *
 * `finishedAt` is taken from Postgres's own clock (`now()`), not `new Date()` in this
 * process: two calls made back to back from the same test need to land on two different
 * instants for "newest" to be decidable at all, and the database's clock advances between
 * two awaited round trips as reliably as anything in this suite does.
 */
async function recordBaseline(
  caseId: string,
  input: { version: number; model: string; reply: string; status?: string },
) {
  const status = input.status ?? 'done';
  const [run] = await db
    .insert(testRuns)
    .values({
      agentId,
      draftId: null,
      configVersion: input.version,
      model: input.model,
      status,
      finishedAt: status === 'done' ? sql`now()` : null,
    })
    .returning();
  await db.insert(testResults).values({
    runId: run!.id,
    caseId,
    reply: input.reply,
    usedChunkIds: [],
    handoff: false,
    outcome: 'unrecorded',
  });
  return run!;
}

/** A draft to hang a non-baseline run off. */
async function openDraft() {
  const [row] = await db
    .insert(kbDrafts)
    .values({
      agentId,
      title: 'Не обещать скидку',
      origin: 'coach',
      status: 'open',
      ops: [{ op: 'rule_create', category: 'forbid', text: 'Не обещай скидку.' }],
      base: {},
    })
    .returning();
  return row!;
}

describe('the baseline a draft is measured against', () => {
  it('reuses a baseline at the same version and model', async () => {
    const kase = await addCase('сколько стоит доставка');
    await recordBaseline(kase.id, { version: 3, model: 'openai/gpt-4o-mini', reply: '1500 ₸.' });
    const found = await baselineResults(db, agentId, [kase.id], 3, 'openai/gpt-4o-mini');
    expect(found.get(kase.id)!.reply).toBe('1500 ₸.');
  });

  it('does not reuse a baseline from an older version', async () => {
    const kase = await addCase('сколько стоит доставка');
    await recordBaseline(kase.id, { version: 3, model: 'openai/gpt-4o-mini', reply: '1500 ₸.' });
    expect((await baselineResults(db, agentId, [kase.id], 4, 'openai/gpt-4o-mini')).size).toBe(0);
  });

  it('does not reuse a baseline from another model', async () => {
    const kase = await addCase('сколько стоит доставка');
    await recordBaseline(kase.id, { version: 3, model: 'openai/gpt-4o-mini', reply: '1500 ₸.' });
    expect((await baselineResults(db, agentId, [kase.id], 3, 'google/gemini-2.5-flash')).size).toBe(0);
  });

  it('takes the newest baseline when there are several', async () => {
    const kase = await addCase('сколько стоит доставка');
    await recordBaseline(kase.id, { version: 3, model: 'openai/gpt-4o-mini', reply: 'старый' });
    await recordBaseline(kase.id, { version: 3, model: 'openai/gpt-4o-mini', reply: 'новый' });
    const found = await baselineResults(db, agentId, [kase.id], 3, 'openai/gpt-4o-mini');
    expect(found.get(kase.id)!.reply).toBe('новый');
  });

  it('returns nothing for a case that has never been run', async () => {
    const kase = await addCase('есть ли рассрочка');
    expect((await baselineResults(db, agentId, [kase.id], 1, 'openai/gpt-4o-mini')).size).toBe(0);
  });

  // Decision 1: what makes a baseline reusable. `configVersion` and `model` matching is not
  // enough on its own — a run that scored a draft (`draft_id` set) answered a hypothetical
  // agent with that draft's operations applied, not the agent as it actually stands. Reusing
  // it as «было» would compare the new draft against an old one instead of against the floor.
  it('does not reuse a result from a run that tested a draft', async () => {
    const kase = await addCase('сколько стоит доставка');
    const draft = await openDraft();
    const [run] = await db
      .insert(testRuns)
      .values({
        agentId,
        draftId: draft.id,
        configVersion: 3,
        model: 'openai/gpt-4o-mini',
        status: 'done',
        finishedAt: sql`now()`,
      })
      .returning();
    await db.insert(testResults).values({
      runId: run!.id,
      caseId: kase.id,
      reply: 'из другого черновика',
      usedChunkIds: [],
      handoff: false,
      outcome: 'unrecorded',
    });

    expect((await baselineResults(db, agentId, [kase.id], 3, 'openai/gpt-4o-mini')).size).toBe(0);
  });

  // Decision 2: "newest" means the newest run that actually finished. A run still `running`
  // has no settled answer yet — reusing its result would show the owner a number the agent
  // never actually landed on, and a second run racing it to finish first would make the
  // comparison depend on timing instead of on what happened.
  it('does not reuse a result from a run that has not finished', async () => {
    const kase = await addCase('сколько стоит доставка');
    await recordBaseline(kase.id, {
      version: 3,
      model: 'openai/gpt-4o-mini',
      reply: 'ещё считается',
      status: 'running',
    });

    expect((await baselineResults(db, agentId, [kase.id], 3, 'openai/gpt-4o-mini')).size).toBe(0);
  });

  // Decision 3: one query, not one per case. Two cases with baselines and a third with none,
  // resolved together — the third's absence from the map is the same "nothing for a case with
  // no baseline" rule the single-case test above proves, now checked alongside cases that do
  // have one, in the one call a real caller (Task 6) actually makes.
  it('resolves several cases in a single call', async () => {
    const delivery = await addCase('сколько стоит доставка');
    const warranty = await addCase('какая гарантия');
    const financing = await addCase('есть ли рассрочка');
    await recordBaseline(delivery.id, { version: 3, model: 'openai/gpt-4o-mini', reply: '1500 ₸.' });
    await recordBaseline(warranty.id, { version: 3, model: 'openai/gpt-4o-mini', reply: '2 года.' });

    const found = await baselineResults(
      db,
      agentId,
      [delivery.id, warranty.id, financing.id],
      3,
      'openai/gpt-4o-mini',
    );

    expect(found.size).toBe(2);
    expect(found.get(delivery.id)!.reply).toBe('1500 ₸.');
    expect(found.get(warranty.id)!.reply).toBe('2 года.');
    expect(found.has(financing.id)).toBe(false);
  });

  // Decision 4: an empty `caseIds` must come back empty, not become a query with no case
  // filter at all — which would match every baseline this agent has ever recorded at this
  // version and model instead of none.
  it('returns nothing for an empty list of cases', async () => {
    const kase = await addCase('сколько стоит доставка');
    await recordBaseline(kase.id, { version: 3, model: 'openai/gpt-4o-mini', reply: '1500 ₸.' });

    expect((await baselineResults(db, agentId, [], 3, 'openai/gpt-4o-mini')).size).toBe(0);
  });

  // The ordering used to be `(caseId, finishedAt desc)` alone, which leaves the tie between
  // two runs that finished at the exact same instant unspecified — both are legitimate
  // «было», but which one wins has to stay fixed, or the same call made twice could answer
  // differently. `finishedAt` is set explicitly here (not `sql\`now()\`` like the other
  // helpers) so the two runs land on the identical instant this test needs; the expected
  // winner is derived from the run ids themselves (`desc(testRuns.id)` is the tiebreaker),
  // not hard-coded, since ids are random.
  it('breaks a tie between two runs that finished at the exact same instant', async () => {
    const kase = await addCase('сколько стоит доставка');
    const shared = new Date('2026-01-01T00:00:00.000Z');

    const insertRun = async (reply: string) => {
      const [run] = await db
        .insert(testRuns)
        .values({
          agentId,
          draftId: null,
          configVersion: 3,
          model: 'openai/gpt-4o-mini',
          status: 'done',
          finishedAt: shared,
        })
        .returning();
      await db.insert(testResults).values({
        runId: run!.id,
        caseId: kase.id,
        reply,
        usedChunkIds: [],
        handoff: false,
        outcome: 'unrecorded',
      });
      return run!;
    };

    const first = await insertRun('первый');
    const second = await insertRun('второй');
    const winner = first.id > second.id ? 'первый' : 'второй';

    const found = await baselineResults(db, agentId, [kase.id], 3, 'openai/gpt-4o-mini');
    expect(found.get(kase.id)!.reply).toBe(winner);

    // Same question, asked again: the answer must not move.
    const again = await baselineResults(db, agentId, [kase.id], 3, 'openai/gpt-4o-mini');
    expect(again.get(kase.id)!.reply).toBe(winner);
  });
});
