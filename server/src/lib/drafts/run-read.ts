/**
 * Reading a draft run back as the «было — стало» table. Shared by `GET …/runs/:runId`, the
 * draft's own run list and the autopilot engine, so a run means the same thing to all three.
 */
import type { TestRun } from '@rakurs/contract';
import { and, asc, eq, gte, isNull } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { testResults, testRuns } from '../../db/schema.js';
import { baselineResults } from './baseline.js';
import { sideFromRow } from './run.js';

/**
 * The baseline run a given draft run's own POST paired with, if it needed one — found without
 * a column linking the two, because the POST that makes a draft run inserts the two back to
 * back, in the same request, with nothing awaited in between: any baseline run at the same
 * `agentId`/`configVersion`/`model` that started at or after `run` did is the one that POST
 * created for it. `baselineResults` can answer a case from an *older* baseline too (one that
 * already existed and was simply reused) — those necessarily started before `run` did, since
 * the POST read them before `run`'s own row was even inserted — so the `>=` here is what tells
 * "paid by this run" apart from "reused from an earlier one". This can misattribute a case to
 * a different, unrelated run that happens to start immediately after `run` and share its
 * agent/version/model while `run` itself needed no fresh baseline at all — accepted as the
 * rare edge a heuristic without a new column has to leave, not a case this feature promises to
 * get right.
 */
export async function pairedBaselineRun(
  db: Db,
  run: typeof testRuns.$inferSelect,
): Promise<typeof testRuns.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(testRuns)
    .where(
      and(
        eq(testRuns.agentId, run.agentId),
        isNull(testRuns.draftId),
        eq(testRuns.configVersion, run.configVersion),
        eq(testRuns.model, run.model),
        gte(testRuns.startedAt, run.startedAt),
      ),
    )
    .orderBy(asc(testRuns.startedAt))
    .limit(1);
  return row ?? null;
}

/** One run with every result row paired with its «было». */
export async function readRun(db: Db, run: typeof testRuns.$inferSelect): Promise<TestRun> {
  const rows = await db.select().from(testResults).where(eq(testResults.runId, run.id));
  // Paired the same way the POST that made this run did — a reload must not show «стало»
  // with nothing beside it. `baselineResults` always answers with the *newest* done
  // baseline at this run's own `configVersion`/`model`, which is exactly what «было» meant
  // at the time this run was scored (and, if a later run has since refreshed it, the
  // freshest known answer at that same version — still the right thing to show).
  const caseIds = rows.map((row) => row.caseId);
  const baselines = await baselineResults(db, run.agentId, caseIds, run.configVersion, run.model);
  const pairedBaseline = await pairedBaselineRun(db, run);

  const results = rows.map((row) => {
    const baseline = baselines.get(row.caseId);
    // `'paid'` exactly when this case's «было» lives in the baseline run paired with `run`
    // itself, `'reused'` when it answers from an older run's own already-`done` row. The label
    // describes which run originally spent the money, not whether this request did.
    const beforeOrigin: 'paid' | 'reused' = pairedBaseline && baseline?.runId === pairedBaseline.id ? 'paid' : 'reused';
    return {
      caseId: row.caseId,
      before: baseline ? { ...sideFromRow(baseline), origin: beforeOrigin } : null,
      after: { ...sideFromRow(row), origin: 'paid' as const },
      // Written only onto the draft's own «стало» row, never the baseline's.
      verdict: row.verdict as 'better' | 'worse' | 'same' | null,
      verdictReason: row.verdictReason,
    };
  });

  return {
    id: run.id,
    draftId: run.draftId,
    configVersion: run.configVersion,
    model: run.model,
    status: run.status as 'running' | 'done' | 'failed',
    draftCost: run.cost,
    baselineCost: pairedBaseline?.cost ?? '0',
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt === null ? null : run.finishedAt.toISOString(),
    results,
  };
}
