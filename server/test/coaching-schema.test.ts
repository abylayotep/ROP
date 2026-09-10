import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client.js';
import { accounts, agentRules, agents, coachMessages } from '../src/db/schema.js';
import { withDb } from './helpers/db.js';

// Same direct-insert pattern as `knowledge-vault-schema.test.ts`: `createAccountWithOwner`
// takes a password and returns `{ accountId, userId }`, not an agent — a schema test only
// needs a row to hang a foreign key off.
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

describe('the coaching schema', () => {
  it('defaults a rule to enabled and remembers where it came from', async () => {
    const [rule] = await db.insert(agentRules)
      .values({ agentId, category: 'forbid', text: 'Не обещай скидку.', origin: 'coach', position: 0 })
      .returning();
    expect(rule!.enabled).toBe(true);
    expect(rule!.origin).toBe('coach');
  });

  it('takes a coach message with no proposal', async () => {
    const [message] = await db.insert(coachMessages)
      .values({ agentId, role: 'owner', text: 'Ты обещал скидку.', status: 'pending' })
      .returning();
    expect(message!.proposal).toBeNull();
  });

  it('deletes a rule with its agent', async () => {
    await db.insert(agentRules)
      .values({ agentId, category: 'tone', text: 'На «вы».', origin: 'manual', position: 0 });
    await db.delete(agents).where(eq(agents.id, agentId));
    expect(await db.select().from(agentRules)).toEqual([]);
  });

  it('no longer carries an instructions column on the agent', async () => {
    const columns = await db.execute(
      sql`select column_name from information_schema.columns where table_name = 'agents'`);
    expect([...columns].map((row) => row.column_name)).not.toContain('instructions');
  });
});
