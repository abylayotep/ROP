/**
 * Where the leads stand now, and what happened to them over a period.
 *
 * Two endpoints rather than one, and the difference between them is the point: the snapshot
 * counts every conversation the cabinet has ever had and has no period at all, while the
 * period report counts movement, which is only recorded from `stageHistorySince` onwards.
 * One route that answered both would let the honest number be read as the one that starts
 * today.
 */
import type { StageStanding, StatsCurrent } from '@rakurs/contract';
import { asc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { Db } from '../db/client.js';
import { conversations, stages } from '../db/schema.js';
import { requireAgent } from './require-agent.js';

export function registerStatsRoutes(
  app: FastifyInstance,
  db: Db,
  guard: preHandlerHookHandler,
): void {
  const anyMember = requireAgent(db);

  /**
   * Сколько лидов стоит сейчас на каждой стадии — снимок на этот момент.
   *
   * Any member, not owner only, for the reason `ai/usage` gives: the settings are the
   * owner's, but what the funnel did is the company's.
   *
   * No period, deliberately. This is the card an owner reads when the movement card looks
   * empty — it counts the leads triaged before the cabinet started recording moves, and a
   * window would hide exactly those.
   */
  app.get(
    '/api/agents/:agentId/stats/current',
    { preHandler: [guard, anyMember] },
    async (req): Promise<StatsCurrent> => {
      // Both statements at once, as `board.ts` does: neither reads the other's result.
      // The counts are grouped in Postgres rather than by reading a row per conversation
      // into Node — an agent with a year of leads has nothing here worth sending over the
      // wire to be tallied.
      const [funnel, counts] = await Promise.all([
        db
          .select()
          .from(stages)
          .where(eq(stages.agentId, req.agent!.id))
          .orderBy(asc(stages.position)),
        db
          .select({
            stageId: conversations.stageId,
            leads: sql<number>`count(*)::int`,
          })
          .from(conversations)
          .where(eq(conversations.agentId, req.agent!.id))
          .groupBy(conversations.stageId),
      ]);

      // Seeded from the stages and not from the counts, the way `board.ts` builds its
      // columns: a stage holding nobody has no row to group, and a stage missing from the
      // answer reads as a stage that does not exist.
      const byStage = new Map<string, number>(funnel.map((stage) => [stage.id, 0]));
      let unsorted = 0;
      for (const row of counts) {
        // A conversation whose stage was deleted lands in `unsorted` too, not nowhere. The
        // delete route refuses a stage that still holds leads, so this cannot happen today;
        // if it ever does, the lead is still counted somewhere.
        if (row.stageId !== null && byStage.has(row.stageId)) byStage.set(row.stageId, row.leads);
        else unsorted += row.leads;
      }

      const standings = funnel.map(
        (stage): StageStanding => ({
          stageId: stage.id,
          name: stage.name,
          color: stage.color,
          kind: stage.kind as StageStanding['kind'],
          position: stage.position,
          // Certain: the map was seeded with a zero for every stage in `funnel`.
          leads: byStage.get(stage.id)!,
        }),
      );

      return {
        stages: standings,
        unsorted,
        // Summed from the same buckets rather than counted again: a third `count(*)` could
        // disagree with the two above it, and a total that does not equal its parts is
        // worse than no total.
        total: standings.reduce((sum, stage) => sum + stage.leads, 0) + unsorted,
        stageHistorySince: req.agent!.stageHistorySince.toISOString(),
      };
    },
  );
}
