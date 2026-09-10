import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client.js';
import { accounts, agents, kbDrafts, testCases, testResults, testRuns } from '../src/db/schema.js';
import { withDb } from './helpers/db.js';

// Same direct-insert pattern as `knowledge-vault-schema.test.ts` and `coaching-schema.test.ts`:
// `createAccountWithOwner` takes a password and returns `{ accountId, userId }`, not an agent —
// a schema test only needs a row to hang a foreign key off.
async function seedAgent(db: Db, name = 'Сафина') {
  const [account] = await db.insert(accounts).values({ name }).returning();
  const [agent] = await db.insert(agents).values({ accountId: account!.id, name }).returning();
  return agent!.id;
}

let db: Awaited<ReturnType<typeof withDb>>;
let agentId: string;

beforeEach(async () => {
  db = await withDb();
  agentId = await seedAgent(db);
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
