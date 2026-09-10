import { and, count, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { agentRules } from '../../db/schema.js';

/**
 * The transaction handle, shared by every write in `api/rules.ts` that has to move more than
 * one row, and by `lib/drafts/ops.ts`'s `applyOps` — a `rule_create` there places its row
 * through the exact same `lockCategories` / `categorySize` pair the routes use, rather than a
 * second implementation that would have to be kept in sync by hand — see `lockCategories` for
 * why a second advisory-lock key formula would not even serialize against this one.
 */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** How many rules an agent already has in a category — and so, the next dense position. */
export async function categorySize(tx: Tx, agentId: string, category: string): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(agentRules)
    .where(and(eq(agentRules.agentId, agentId), eq(agentRules.category, category)));
  return row?.n ?? 0;
}

/**
 * Locks one or more of an agent's rule categories for the rest of this transaction —
 * `pg_advisory_xact_lock`, one call per category, always in ascending category-name order.
 *
 * **Why an advisory lock and not `SELECT … FOR UPDATE`.** A row lock can only lock rows that
 * exist. `categorySize` and `current.position` are both reads of a snapshot — under
 * Postgres's default READ COMMITTED, two transactions each take their own snapshot, so two
 * requests touching the same category can both read the same `categorySize`, compute the
 * same target, and then each write their own row by primary key; those writes never block
 * each other (different rows), so both commit and the category ends with a duplicated
 * position and a gap. `FOR UPDATE` over the category's existing rows closed that for every
 * category that already had a row in it (a reviewer measured the unfixed version at 3
 * duplicate-position outcomes in 20 concurrent trials) — but a category that has never held
 * a rule for this agent has nothing to lock, so two concurrent *first-ever* `POST`s into it
 * both saw an empty table, both counted zero, and both inserted at position 0. That hole
 * isn't a corner case: every category of every agent starts empty, so it's the first two
 * rules an owner ever types. A reviewer measured the unfixed `FOR UPDATE` version at 19 of
 * 20 trials landing a duplicate in that state (see the test below) — an advisory lock is
 * keyed on `(agentId, category)` directly rather than on a row, so it's held whether or not
 * the category has any rows yet, and closes both races with one mechanism.
 *
 * **The key.** `hashtextextended(agentId || ':' || category, 0)` turns the pair into one
 * `bigint`, which goes straight into the single-key overload of `pg_advisory_xact_lock`
 * (`pg_advisory_xact_lock(bigint)`) rather than the two-`int`-key overload
 * (`pg_advisory_xact_lock(int, int)`) — one lock namespace, not a pair to keep in sync. The
 * `':'` separator is redundant given `agentId` is a fixed-length UUID and `category` is one
 * of four fixed strings (concatenation alone can't collide two different pairs), but it
 * costs nothing and keeps the intent legible. `hashtextextended` is a 64-bit hash of
 * arbitrary text, not an injective encoding, so two different `(agentId, category)` pairs
 * could in principle hash to the same key and serialize against each other unnecessarily —
 * that's harmless (a false lock contention at worst, never a false *absence* of one), so it
 * isn't worth guarding against.
 *
 * **Transaction-scoped, on purpose.** `pg_advisory_xact_lock` (not the session variant,
 * `pg_advisory_lock`) releases automatically when this transaction commits or rolls back —
 * there is no unlock call anywhere in this file, and none is needed.
 *
 * **Lock order.** A `PATCH` that changes category locks both the rule's old category and its
 * new one. A second `PATCH` moving a different rule the opposite way (old and new swapped)
 * would, left to its own order, lock them old-then-new too — the *same two* categories, but
 * potentially requested in the opposite order, which is exactly the setup for an AB-BA
 * deadlock. Sorting the category names before locking means every transaction that ever
 * needs this pair of categories asks for them in the same order, so no cycle can form: the
 * standard resource-ordering argument for deadlock freedom applies directly, and it doesn't
 * matter which direction any individual move runs in. Single-category operations (`POST`,
 * `DELETE`, same-category `PATCH`) only ever hold one lock at a time, so they can't be a link
 * in a two-resource cycle either.
 */
export async function lockCategories(tx: Tx, agentId: string, categories: readonly string[]): Promise<void> {
  for (const category of [...new Set(categories)].sort()) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${agentId} || ':' || ${category}, 0))`);
  }
}
