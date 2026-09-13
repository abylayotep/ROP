import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { testCases, testResults, testRuns } from '../../db/schema.js';

/**
 * Whether a draft is provably safe to apply *right now* — some run of it finished `done` at
 * the agent's *current* `config_version`. This is only one of the apply route's four checks
 * (`api/drafts.ts`'s own comment on that route names the rest: draft status, `staleOps`, and
 * this one), but it is the one a screen needs in order to answer "would «Применить» work"
 * without guessing — which used to mean tracking a run session-locally and losing the answer
 * on every reload.
 *
 * Pulled out here rather than left inline in the apply route so that route and
 * `GET .../drafts/:draftId` call the exact same function instead of keeping two copies of the
 * same query: a screen's `applicable` flag and the apply route's own refusal must always agree
 * about what "tested" means, and two copies is how they quietly stop agreeing.
 */
export async function isDraftApplicable(db: Db, draftId: string, currentConfigVersion: number): Promise<boolean> {
  const [required] = await db.select({ id: testCases.id }).from(testCases)
    .where(eq(testCases.requiredDraftId, draftId)).limit(1);
  if (required) {
    const [latest] = await db.select({ id: testRuns.id, status: testRuns.status })
      .from(testRuns).where(and(eq(testRuns.draftId, draftId), eq(testRuns.configVersion, currentConfigVersion)))
      .orderBy(desc(testRuns.startedAt), desc(testRuns.id)).limit(1);
    if (!latest || latest.status !== 'done') return false;
    const [result] = await db.select({ outcome: testResults.outcome }).from(testResults)
      .where(and(eq(testResults.runId, latest.id), eq(testResults.caseId, required.id))).limit(1);
    return result !== undefined && ['sent', 'applied', 'handoff'].includes(result.outcome);
  }
  const [row] = await db
    .select({ id: testRuns.id })
    .from(testRuns)
    .where(
      and(eq(testRuns.draftId, draftId), eq(testRuns.status, 'done'), eq(testRuns.configVersion, currentConfigVersion)),
    )
    .limit(1);
  return row !== undefined;
}
