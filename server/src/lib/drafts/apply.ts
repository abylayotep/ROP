import { and, eq, notLike, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { agents, kbDrafts, kbGenerationDrafts, kbGenerationProposals, kbGenerationRuns, testRuns } from '../../db/schema.js';
import { ApiError, isDuplicate } from '../errors.js';
import { LEGACY_RAW_FINGERPRINT_PATTERN } from '../knowledge/generation-types.js';
import { isDraftApplicable } from './applicable.js';
import { applyOps, staleOps } from './ops.js';
import { DUPLICATE_NOTE_PATH_MESSAGE } from './run.js';
import { bumpConfigVersion } from './version.js';

/**
 * Applies an open draft for real, in one transaction, keeping the promise that what was tested
 * is what lands. Refused, in this order and under the same lock as the write:
 *
 * 1. The draft is not `open` (applied, discarded, or beaten to the row lock by a racing apply).
 * 2. No run of it ever finished `done` — "never tested" is a different sentence than (4).
 * 3. `staleOps` names a touched row that moved. Checked before (4) although such a move also
 *    bumped the version, because naming the exact row is what the owner needs to hear.
 * 4. The `done` run is not at the agent's current `config_version` — the catch-all for changes
 *    `staleOps` cannot see, such as a neighbouring reorder.
 *
 * The annotator's verdict gates nothing here; the button is under a human hand. Bumping the
 * version is the point: it retires every baseline measured before these ops landed.
 */
export async function applyDraft(
  db: Db,
  input: { agentId: string; draftId: string },
): Promise<typeof kbDrafts.$inferSelect> {
  const { agentId, draftId } = input;
  return db.transaction(async (tx) => {
    // A single-row lock: a second apply waits here instead of both reading `open`.
    const [draft] = await tx
      .select()
      .from(kbDrafts)
      .where(and(eq(kbDrafts.id, draftId), eq(kbDrafts.agentId, agentId)))
      .for('update');
    if (!draft) throw new ApiError(404, 'Черновик не найден');
    if (draft.status !== 'open') {
      throw new ApiError(409, 'Черновик уже применён или отклонён');
    }

    const [agent] = await tx
      .select({ configVersion: agents.configVersion })
      .from(agents)
      .where(eq(agents.id, agentId));
    if (!agent) throw new ApiError(404, 'Агент не найден');

    // `running` and a restart-orphaned `failed` prove nothing, the same as no run at all.
    const [everRun] = await tx
      .select({ id: testRuns.id })
      .from(testRuns)
      .where(and(eq(testRuns.draftId, draft.id), eq(testRuns.status, 'done')))
      .limit(1);
    if (!everRun) {
      throw new ApiError(409, 'Черновик не прогнан — сначала проверьте его');
    }

    const stale = await staleOps(tx as unknown as Db, agentId, draft.ops, draft.base);
    if (stale.length > 0) {
      const names = stale.map((name) => `«${name}»`).join(', ');
      throw new ApiError(409, `Изменилось с тех пор, как черновик проверен: ${names} — прогоните черновик заново`);
    }

    // The same call `GET …/drafts/:draftId` makes for `applicable`, so the two always agree.
    if (!(await isDraftApplicable(tx as unknown as Db, draft.id, agent.configVersion))) {
      throw new ApiError(409, 'База изменилась после проверки — прогоните черновик заново');
    }

    const linkedRuns = await tx.selectDistinct({ runId: kbGenerationProposals.runId })
      .from(kbGenerationProposals)
      .innerJoin(kbGenerationRuns, and(
        eq(kbGenerationRuns.id, kbGenerationProposals.runId),
        eq(kbGenerationRuns.agentId, agentId),
      ))
      .where(and(
        eq(kbGenerationProposals.draftId, draft.id),
        notLike(kbGenerationProposals.fingerprint, LEGACY_RAW_FINGERPRINT_PATTERN),
      ));
    if (linkedRuns.length > 0) {
      await tx.insert(kbGenerationDrafts).values(linkedRuns.map(({ runId }) => ({ runId, draftId: draft.id })))
        .onConflictDoNothing();
    }

    // A `note_create` onto a path another note has since taken passes every check above (it
    // names no existing row) and raises a raw unique violation; answer it as a 409, not a 500.
    try {
      await applyOps(tx as unknown as Db, agentId, draft.ops, async (opIndex, noteId) => {
        await tx.update(kbGenerationProposals).set({
          status: 'applied',
          noteId,
          revision: sql`${kbGenerationProposals.revision} + 1`,
          updatedAt: new Date(),
        }).where(and(
          eq(kbGenerationProposals.draftId, draft.id),
          eq(kbGenerationProposals.draftOpIndex, opIndex),
          notLike(kbGenerationProposals.fingerprint, LEGACY_RAW_FINGERPRINT_PATTERN),
        ));
      });
    } catch (error) {
      if (isDuplicate(error)) throw new ApiError(409, DUPLICATE_NOTE_PATH_MESSAGE);
      throw error;
    }
    await bumpConfigVersion(tx as unknown as Db, agentId);

    const [row] = await tx
      .update(kbDrafts)
      .set({ status: 'applied', appliedAt: sql`now()` })
      .where(eq(kbDrafts.id, draft.id))
      .returning();
    return row!;
  });
}
