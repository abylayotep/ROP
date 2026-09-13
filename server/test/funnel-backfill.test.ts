import { readFile } from 'node:fs/promises';
import { asc, eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { accounts, agents, stages } from '../src/db/schema.js';
import { DEFAULT_STAGES } from '../src/lib/funnel.js';
import { withDb } from './helpers/db.js';

const MIGRATIONS = [
  'drizzle/0005_seed_default_funnel.sql',
  'drizzle/0026_paid_funnel_labels.sql',
  'drizzle/0050_merge_awaiting_payment.sql',
];

let db: Awaited<ReturnType<typeof withDb>>;

/**
 * Runs the backfill and the later migrations that reshape the default funnel, exactly as shipped.
 *
 * The harness migrates once and truncates per test, so an agent inserted afterwards can
 * never be caught by `migrate()` itself — by then the migration is recorded as applied.
 * Reading the file and executing it is what still tests the shipped statement rather than
 * a copy of it: change the file and this test changes with it.
 */
async function runBackfill(): Promise<void> {
  for (const migration of MIGRATIONS) {
    const text = await readFile(migration, 'utf8');
    for (const statement of text.split('--> statement-breakpoint')) {
      if (statement.trim() !== '') await db.execute(sql.raw(statement));
    }
  }
}

/** An agent written straight into the table, the way every pre-branch agent got there. */
async function insertAgentWithoutRoute(name: string): Promise<string> {
  const [account] = await db.insert(accounts).values({ name }).returning();
  const [agent] = await db.insert(agents).values({ accountId: account!.id, name }).returning();
  return agent!.id;
}

const funnelOf = (agentId: string) =>
  db.select().from(stages).where(eq(stages.agentId, agentId)).orderBy(asc(stages.position));

beforeEach(async () => {
  db = await withDb();
});

describe('the funnel backfill migration', () => {
  it('gives the default funnel to an agent that has none', async () => {
    const agentId = await insertAgentWithoutRoute('Сафина');
    expect(await funnelOf(agentId)).toHaveLength(0);

    await runBackfill();

    const rows = await funnelOf(agentId);
    expect(rows).toHaveLength(DEFAULT_STAGES.length);
    expect(rows.map((row) => row.name)).toEqual(DEFAULT_STAGES.map((stage) => stage.name));
    expect(rows.map((row) => row.color)).toEqual(DEFAULT_STAGES.map((stage) => stage.color));
    expect(rows.map((row) => row.kind)).toEqual(DEFAULT_STAGES.map((stage) => stage.kind));
    expect(rows.map((row) => row.position)).toEqual(DEFAULT_STAGES.map((_, i) => i));
    expect(rows.filter((row) => row.kind === 'success')).toHaveLength(1);
  });

  it('adds nothing the second time it runs', async () => {
    const agentId = await insertAgentWithoutRoute('Вторая');

    await runBackfill();
    await runBackfill();

    expect(await funnelOf(agentId)).toHaveLength(DEFAULT_STAGES.length);
  });

  it('leaves a funnel an owner has already reshaped alone', async () => {
    const agentId = await insertAgentWithoutRoute('Третья');
    await db
      .insert(stages)
      .values({ agentId, name: 'Своя стадия', color: '#111111', kind: 'success', position: 0 });

    await runBackfill();

    const rows = await funnelOf(agentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe('Своя стадия');
  });
});
