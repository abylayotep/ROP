import { and, asc, count, eq, gt, gte, lt, lte, sql } from 'drizzle-orm';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { agentRules } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import { RULE_CATEGORY_ORDER } from '../lib/ai/rules.js';
import { isUuid } from '../lib/uuid.js';
import { requireAgent } from './require-agent.js';

const CATEGORIES = ['business', 'tone', 'order', 'forbid'] as const;
type Category = (typeof CATEGORIES)[number];

/** A rule is a sentence, not an essay — see `agent_rules` in schema.ts. */
const RULE_MAX = 500;

const createRule = z.object({
  category: z.enum(CATEGORIES),
  text: z.string().trim().min(1).max(RULE_MAX),
  // Set only when the owner insisted past the fact check; the coach route passes it.
  warning: z.string().max(200).nullish(),
});

const updateRule = z.object({
  category: z.enum(CATEGORIES).optional(),
  text: z.string().trim().min(1).max(RULE_MAX).optional(),
  enabled: z.boolean().optional(),
  position: z.number().int().min(0).max(999).optional(),
});

/**
 * The message for the field that actually failed a write.
 *
 * A rule has three fields a request can get wrong, and `issue.path[0]` says which; falling
 * back to one generic message for a category typo would leave an owner who wrote 600
 * characters of a rule believing the category name was the problem.
 */
function ruleError(issue: { code: string; path: readonly PropertyKey[] } | undefined): ApiError {
  if (issue?.path[0] === 'category') {
    return new ApiError(400, `Неизвестная категория. Возможные: ${CATEGORIES.join(', ')}`);
  }
  if (issue?.path[0] === 'text') {
    return issue.code === 'too_big'
      ? new ApiError(400, `Текст правила длиннее ${RULE_MAX} символов`)
      : new ApiError(400, 'Укажите текст правила');
  }
  if (issue?.path[0] === 'position') return new ApiError(400, 'Некорректная позиция');
  return new ApiError(400, 'Не удалось разобрать правило');
}

const toRule = (row: typeof agentRules.$inferSelect) => ({
  id: row.id,
  category: row.category as Category,
  text: row.text,
  enabled: row.enabled,
  origin: row.origin as 'manual' | 'coach',
  position: row.position,
  warning: row.warning,
  updatedAt: row.updatedAt.toISOString(),
});

/** The transaction handle, shared by every write below that has to move more than one row. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** How many rules an agent already has in a category — and so, the next dense position. */
async function categorySize(tx: Tx, agentId: string, category: string): Promise<number> {
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
async function lockCategories(tx: Tx, agentId: string, categories: readonly string[]): Promise<void> {
  for (const category of [...new Set(categories)].sort()) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${agentId} || ':' || ${category}, 0))`);
  }
}

export function registerRuleRoutes(app: FastifyInstance, db: Db, guard: preHandlerHookHandler): void {
  // Rules shape what the agent is and what it costs to run; changing them is the owner's
  // call, not an operator's — every route below, the read included.
  const ownerOnly = requireAgent(db, { role: 'owner' });

  /**
   * One agent's rule, or 404 — never another agent's, and never a bare 500.
   *
   * `executor` defaults to `db` for the plain, unlocked lookups (the initial 404 check
   * before a route even opens a transaction), and is passed as `tx` wherever a caller has
   * already locked this row's category and needs an authoritative re-read against that
   * lock rather than a fresh, separately-snapshotted query.
   */
  async function loadRule(
    agentId: string,
    ruleId: string,
    executor: Db | Tx = db,
  ): Promise<typeof agentRules.$inferSelect> {
    if (!isUuid(ruleId)) throw new ApiError(404, 'Правило не найдено');
    const [row] = await executor
      .select()
      .from(agentRules)
      .where(and(eq(agentRules.id, ruleId), eq(agentRules.agentId, agentId)));
    if (!row) throw new ApiError(404, 'Правило не найдено');
    return row;
  }

  /** Where a category ranks in the order `assembleRules` (lib/ai/rules.ts) renders it in. */
  const categoryRank = new Map(RULE_CATEGORY_ORDER.map((category, i) => [category, i]));

  app.get(
    '/api/agents/:agentId/rules',
    { preHandler: [guard, ownerOnly] },
    async (req) => {
      const rows = await db
        .select()
        .from(agentRules)
        .where(eq(agentRules.agentId, req.agent!.id))
        .orderBy(asc(agentRules.position));
      // Sorted here rather than by the query, in the order `assembleRules` defines
      // (`RULE_CATEGORY_ORDER`) rather than SQL's alphabetical `asc(category)` — the model
      // reads business, tone, order, forbid, and a screen showing the wire order otherwise
      // would show the owner a sequence the agent never uses. `Array.sort` is stable, and
      // the query above already orders by `position`, so rows sharing a category keep the
      // order the owner arranged them in.
      return rows
        .map(toRule)
        .sort((a, b) => (categoryRank.get(a.category) ?? 99) - (categoryRank.get(b.category) ?? 99));
    },
  );

  app.post(
    '/api/agents/:agentId/rules',
    { preHandler: [guard, ownerOnly] },
    async (req) => {
      const parsed = createRule.safeParse(req.body);
      if (!parsed.success) throw ruleError(parsed.error.issues[0]);
      const { category, text, warning } = parsed.data;
      const agentId = req.agent!.id;

      const row = await db.transaction(async (tx) => {
        // Locks the category before counting it, so a concurrent create (or move, or
        // delete) in the same category waits here and then counts what this transaction
        // actually leaves behind — including a category with no rows yet, which is exactly
        // why this is an advisory lock rather than `SELECT … FOR UPDATE`. See `lockCategories`.
        await lockCategories(tx, agentId, [category]);
        // A new rule joins the end of its category. `categorySize` is the count of rows
        // already there, which — because every write here keeps positions dense and
        // starting at 0 — is exactly the next free slot.
        const position = await categorySize(tx, agentId, category);
        const [created] = await tx
          .insert(agentRules)
          .values({ agentId, category, text, position, warning: warning ?? null })
          .returning();
        return created!;
      });
      return toRule(row);
    },
  );

  /**
   * Moves a rule to `target` inside `category`, shifting the rows between its old and new
   * position by one to close the gap it leaves and open the one it takes.
   *
   * Both shifts are plain range updates over disjoint rows — the moved row's own old
   * position sits at the excluded end of whichever range applies, so it is never touched
   * here and is written separately by the caller. No unique constraint sits on
   * `(agent_id, category, position)` (see schema.ts), so there is nothing to serialize
   * against mid-transaction: the two updates below and the caller's own write to the moved
   * row are the only statements touching this category, all inside one transaction.
   */
  async function shiftForMove(tx: Tx, agentId: string, category: string, from: number, to: number): Promise<void> {
    if (from === to) return;
    if (to < from) {
      // The rows from `to` up to (but not including) `from` slide down to make room above.
      await tx
        .update(agentRules)
        .set({ position: sql`${agentRules.position} + 1` })
        .where(
          and(
            eq(agentRules.agentId, agentId),
            eq(agentRules.category, category),
            gte(agentRules.position, to),
            lt(agentRules.position, from),
          ),
        );
    } else {
      // The rows from just after `from` up to `to` slide up to close the gap left below.
      await tx
        .update(agentRules)
        .set({ position: sql`${agentRules.position} - 1` })
        .where(
          and(
            eq(agentRules.agentId, agentId),
            eq(agentRules.category, category),
            gt(agentRules.position, from),
            lte(agentRules.position, to),
          ),
        );
    }
  }

  app.patch(
    '/api/agents/:agentId/rules/:ruleId',
    { preHandler: [guard, ownerOnly] },
    async (req) => {
      const { ruleId } = req.params as { ruleId: string };
      const agentId = req.agent!.id;
      // Fast 404 before opening a transaction — but only ever used below to know *which*
      // category(ies) to lock. Everything that actually reads position or category uses
      // the re-read taken after the lock, not this one: this snapshot is taken before any
      // lock exists, so a concurrent request could have already moved this exact row by
      // the time the transaction below starts.
      const probe = await loadRule(agentId, ruleId);

      const parsed = updateRule.safeParse(req.body);
      if (!parsed.success) throw ruleError(parsed.error.issues[0]);
      const { category, text, enabled, position } = parsed.data;

      const row = await db.transaction(async (tx) => {
        const categoriesToLock =
          category !== undefined && category !== probe.category ? [probe.category, category] : [probe.category];
        // Locks the category (both of them, for a move) before this transaction reads
        // anything position-shaped. A second PATCH touching the same category blocks here
        // — see `lockCategories` — which also fixes the lock order across the pair so two
        // moves running in opposite directions can never deadlock against each other.
        await lockCategories(tx, agentId, categoriesToLock);

        // Re-read now that the lock is held, rather than trusting `probe`: the lock makes
        // this read authoritative for anything still inside `categoriesToLock`.
        const current = await loadRule(agentId, ruleId, tx);
        if (!categoriesToLock.includes(current.category)) {
          // Between `probe` and the lock above, some other transaction already committed a
          // move of this *exact* rule to a category neither lock covers — only possible
          // when two requests race to move the same rule (not the reported scenario, which
          // moves two different rules), and too rare to guess our way through: proceeding
          // would mean writing against a category this transaction never locked, which is
          // the same unprotected write the lock exists to prevent.
          throw new ApiError(409, 'Правило уже изменили, повторите запрос');
        }

        const movingCategory = category !== undefined && category !== current.category;

        if (movingCategory) {
          // Leaving the old category closes the gap this rule leaves behind there.
          await tx
            .update(agentRules)
            .set({ position: sql`${agentRules.position} - 1` })
            .where(
              and(
                eq(agentRules.agentId, agentId),
                eq(agentRules.category, current.category),
                gt(agentRules.position, current.position),
              ),
            );

          // Joining the new category with no position given goes to its end — the same
          // place a brand new rule would land, since this rule is, to that category, new.
          const size = await categorySize(tx, agentId, category);
          const target = Math.min(position ?? size, size);

          await tx
            .update(agentRules)
            .set({ position: sql`${agentRules.position} + 1` })
            .where(
              and(
                eq(agentRules.agentId, agentId),
                eq(agentRules.category, category),
                gte(agentRules.position, target),
              ),
            );

          const [updated] = await tx
            .update(agentRules)
            .set({
              category,
              position: target,
              text: text ?? current.text,
              enabled: enabled ?? current.enabled,
              updatedAt: new Date(),
            })
            .where(eq(agentRules.id, current.id))
            .returning();
          return updated!;
        }

        if (position !== undefined) {
          // Clamped to the category's own range: a position past the last rule would leave
          // that rule's slot empty and the moved one floating past it, which is a gap by
          // another name. Clamping keeps position dense without answering a generous
          // number with a 400.
          const size = await categorySize(tx, agentId, current.category);
          const target = Math.min(position, size - 1);
          await shiftForMove(tx, agentId, current.category, current.position, target);

          const [updated] = await tx
            .update(agentRules)
            .set({
              position: target,
              text: text ?? current.text,
              enabled: enabled ?? current.enabled,
              updatedAt: new Date(),
            })
            .where(eq(agentRules.id, current.id))
            .returning();
          return updated!;
        }

        const [updated] = await tx
          .update(agentRules)
          .set({
            text: text ?? current.text,
            enabled: enabled ?? current.enabled,
            updatedAt: new Date(),
          })
          .where(eq(agentRules.id, current.id))
          .returning();
        return updated!;
      });

      return toRule(row);
    },
  );

  app.delete(
    '/api/agents/:agentId/rules/:ruleId',
    { preHandler: [guard, ownerOnly] },
    async (req) => {
      const { ruleId } = req.params as { ruleId: string };
      const agentId = req.agent!.id;
      // Fast 404 before opening a transaction — see the PATCH route's `probe` for why this
      // isn't the read the delete itself relies on.
      const probe = await loadRule(agentId, ruleId);

      await db.transaction(async (tx) => {
        // Locks the category before touching any position in it, for the same reason the
        // PATCH route does: a concurrent create, delete, or move in this category needs to
        // wait here rather than race this transaction's shift.
        await lockCategories(tx, agentId, [probe.category]);

        const current = await loadRule(agentId, ruleId, tx);
        if (current.category !== probe.category) {
          // A concurrent PATCH already moved this exact row out of the category this
          // transaction locked, in the gap between `probe` and the lock. See the PATCH
          // route's identical check for why this is answered with a retry rather than a
          // guess.
          throw new ApiError(409, 'Правило уже изменили, повторите запрос');
        }

        await tx.delete(agentRules).where(eq(agentRules.id, current.id));
        // The hole a delete leaves is closed immediately, not left for the next create to
        // trip over: `categorySize` hands a new rule the category's row count as its
        // position, and a gap below that count would make the new rule's position collide
        // with a rule already sitting past the gap — two rows in one slot, ordered however
        // Postgres feels like rather than however the owner arranged them.
        await tx
          .update(agentRules)
          .set({ position: sql`${agentRules.position} - 1` })
          .where(
            and(
              eq(agentRules.agentId, agentId),
              eq(agentRules.category, current.category),
              gt(agentRules.position, current.position),
            ),
          );
      });

      return { ok: true };
    },
  );
}
