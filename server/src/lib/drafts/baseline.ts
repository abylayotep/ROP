import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { testResults, testRuns } from '../../db/schema.js';

/**
 * The newest «было» for each case: what the agent, as it stands, last answered — reused
 * instead of run again so the owner pays once per case, not once per draft that tests it.
 *
 * Reusable exactly when three things hold, and wrong to reuse the moment any one of them
 * does not:
 *
 * - `configVersion` and `model` both match. `configVersion` is bumped (`version.ts`) by
 *   every change that could change an answer — the knowledge vault, the rules, and the
 *   agent's own settings including temperature, which has no column of its own on
 *   `test_runs` for exactly this reason: it is covered through the version it bumps, not
 *   tracked a second time next to it. Together the two columns are the whole story `test_runs`
 *   tells about which build of the agent produced a row.
 * - `draft_id is null`. A run with a draft id measured a hypothetical agent — that draft's
 *   operations applied on top of the real one — not the agent on the floor. Reusing its
 *   result as «было» would silently compare the new draft against an old, possibly
 *   never-landed one instead of against what a customer is actually getting today.
 * - `status = 'done'`. A `running` run has not settled on an answer yet, and a `failed` one
 *   never did; either reused as «было» would show the owner a number the agent did not
 *   actually produce.
 *
 * One query for every id in `caseIds`, not one per case — `caseIds` is a draft's whole test
 * suite, and a suite of any size is one round trip here or it is N. `DISTINCT ON` picks the
 * newest matching row per case directly in the `ORDER BY` the query already needs for
 * "newest": a `GROUP BY … HAVING max(finished_at)` would still need a second join back to
 * fetch the rest of the row, and a `row_number()` window would need an outer query to filter
 * down to the first one — `DISTINCT ON` does both in the one clause.
 */
export async function baselineResults(
  db: Db,
  agentId: string,
  caseIds: string[],
  configVersion: number,
  model: string,
): Promise<Map<string, typeof testResults.$inferSelect>> {
  // `inArray` on an empty list renders a clause that matches nothing in this drizzle version,
  // but that is an implementation detail of a library, not a guarantee this function makes —
  // returning here keeps "no cases in, nothing out" true regardless of what a future version
  // does with an empty IN-list, and skips a round trip that has a known answer already.
  if (caseIds.length === 0) return new Map();

  const rows = await db
    .selectDistinctOn([testResults.caseId], { result: testResults })
    .from(testResults)
    .innerJoin(testRuns, eq(testResults.runId, testRuns.id))
    .where(
      and(
        eq(testRuns.agentId, agentId),
        isNull(testRuns.draftId),
        eq(testRuns.configVersion, configVersion),
        eq(testRuns.model, model),
        eq(testRuns.status, 'done'),
        inArray(testResults.caseId, caseIds),
      ),
    )
    // `DISTINCT ON` requires its leading order to be the distinct columns themselves; the
    // `finished_at desc` after it is what picks the newest row within each case. `run id desc`
    // is a final tiebreaker for two runs that finished at the exact same instant — both are
    // equally legitimate «было», but which one wins has to be fixed, or «было» could flip
    // between two calls that ask the same question at the same configVersion and model.
    .orderBy(testResults.caseId, desc(testRuns.finishedAt), desc(testRuns.id));

  return new Map(rows.map(({ result }) => [result.caseId, result]));
}
