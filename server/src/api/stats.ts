/**
 * Where the leads stand now, and what happened to them over a period.
 *
 * Two endpoints rather than one, and the difference between them is the point: the snapshot
 * counts every conversation the cabinet has ever had and has no period at all, while the
 * period report counts movement, which is only recorded from `stageHistorySince` onwards.
 * One route that answered both would let the honest number be read as the one that starts
 * today.
 */
import type {
  FunnelStep,
  StageKind,
  StageStanding,
  StatsCurrent,
  StatsMoney,
  StatsPeriodReport,
  StatsSource,
} from '@rakurs/contract';
import { and, asc, eq, gte, isNotNull, ne, or, sql } from 'drizzle-orm';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { Db } from '../db/client.js';
import { conversations, orders, stages, stageTransitions } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import { periodQuery, periodSince } from '../lib/period.js';
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

  /**
   * Что происходило с лидами за период — воронка, источники и деньги.
   *
   * Any member, for the reason the snapshot above gives.
   *
   * The window is rolling and computed here, not in the browser, and answered back as
   * `since` so the screen names the same instant the numbers were counted from.
   */
  app.get(
    '/api/agents/:agentId/stats/period',
    { preHandler: [guard, anyMember] },
    async (req): Promise<StatsPeriodReport> => {
      const parsed = periodQuery.safeParse(req.query);
      if (!parsed.success) throw new ApiError(400, 'Неизвестный период');
      const period = parsed.data.period ?? 'week';
      const since = periodSince(period);
      const agentId = req.agent!.id;
      const currency = req.agent!.currency;

      /**
       * Conversations created inside the window — the cohort every source figure counts.
       *
       * Cohorting by creation rather than by anything the lead did later is what makes two
       * periods comparable: the click happened when the thread was created, and a lead that
       * arrived in March is not this week's lead however much it moved this week.
       *
       * Written as a scalar subquery rather than a fifth statement because the per-lead
       * money figure divides by it, and a denominator fetched separately could be counted
       * against a different instant than the sum above it.
       */
      //
      // The instant is spelled out and cast rather than handed over as a `Date`: inside a
      // raw fragment the driver is given no column to infer a type from, and a `Date` there
      // reaches it as an object it refuses to serialise. The comparison operators below do
      // this conversion themselves, which is why only the fragments say it out loud.
      const sinceText = since.toISOString();
      const newLeadsSql = sql`select count(*) from ${conversations}
        where ${conversations.agentId} = ${agentId}
          and ${conversations.createdAt} >= ${sinceText}::timestamptz`;

      const [funnelRows, counterRows, sourceRows, moneyRows] = await Promise.all([
        // The chain, and how many distinct leads entered each of its stages.
        //
        // `kind <> 'failure'` keeps «Отказ» out of the chain. It sits at position 8, after
        // «Продажа», and a chain that walked through it would read a refusal as a step
        // towards a sale; it is counted beside the chain, as `failureEntries`.
        //
        // `count(distinct …)` is the whole defence against a lead sent back for a second
        // attempt inflating the column it returned to: a lead dragged out of «В диалоге»
        // and back three times entered it once as far as this period is concerned.
        //
        // A left join rather than a grouped read merged afterwards: `count(distinct …)`
        // over no matched row is already the zero a stage nobody entered has to show, and
        // a stage missing from the chain would read as a stage that does not exist.
        //
        // The join needs no tenancy clause of its own. `to_stage_id` points at a row of
        // `stages`, and the `where` below has already restricted those to this agent.
        db
          .select({
            stageId: stages.id,
            name: stages.name,
            kind: stages.kind,
            position: stages.position,
            entered: sql<number>`count(distinct ${stageTransitions.conversationId})::int`,
          })
          .from(stages)
          .leftJoin(
            stageTransitions,
            and(
              eq(stageTransitions.toStageId, stages.id),
              gte(stageTransitions.occurredAt, since),
            ),
          )
          .where(and(eq(stages.agentId, agentId), ne(stages.kind, 'failure')))
          .groupBy(stages.id, stages.name, stages.kind, stages.position)
          .orderBy(asc(stages.position)),

        // The three figures that stand beside the chain, plus the count that says whether
        // anything moved at all.
        //
        // `failureEntries` reads the snapshot `to_kind` rather than joining `stages`: a
        // refusal into a stage the owner has since deleted still happened, and a join would
        // quietly stop counting it.
        //
        // `backwardMoves` is not distinct, deliberately — the question it answers is how
        // often leads are sent back, not how many leads were.
        //
        // The names of deleted stages are capped and the tail dropped: this line exists so
        // a funnel whose totals do not add up says why, and ten names say that as well as
        // fifty would.
        db
          .select({
            moves: sql<number>`count(*)::int`,
            failureEntries: sql<number>`(count(distinct ${stageTransitions.conversationId})
              filter (where ${stageTransitions.toKind} = 'failure'))::int`,
            backwardMoves: sql<number>`(count(*)
              filter (where ${stageTransitions.toPosition} < ${stageTransitions.fromPosition}))::int`,
            deletedStageEntries: sql<number>`(count(*)
              filter (where ${stageTransitions.toStageId} is null))::int`,
            deletedStageNames: sql<string[]>`coalesce(
              (array_agg(distinct ${stageTransitions.toName})
                filter (where ${stageTransitions.toStageId} is null))[1:10],
              '{}'::text[])`,
          })
          .from(stageTransitions)
          .where(
            and(eq(stageTransitions.agentId, agentId), gte(stageTransitions.occurredAt, since)),
          ),

        // One row per advertisement, over the cohort.
        //
        // Threads carrying a `ctwa_clid` and no `ad_source_id` collapse into a single row
        // with `sourceId: null` — the click happened and is worth counting, and the screen
        // labels it. Threads with neither are not sources at all, and are the difference
        // between `newLeads` and `leadsFromAds`.
        //
        // `won` is where the lead stands **now**, not a transition: a sale is a fact about
        // the present, available for every lead including the ones triaged before the
        // cabinet began recording movement.
        //
        // `paidTotal` counts **every** paid order of those conversations whatever its
        // `paid_at`, so a lead who clicked inside the window and paid a month later still
        // credits the ad that brought them. A past period's figure therefore grows after
        // the fact; the card says so in words rather than hiding it.
        //
        // Summed in Postgres and cast wider than the column — see the money statement below
        // for why `numeric(16,2)` and why `::text`.
        db
          .select({
            sourceId: conversations.adSourceId,
            // `max()` over a group whose rows all carry the same ad: the headline and the
            // placement do not vary within one `ad_source_id`, and picking one row's value
            // needs no window function.
            sourceType: sql<string | null>`max(${conversations.adSourceType})`,
            headline: sql<string | null>`max(${conversations.adHeadline})`,
            leads: sql<number>`count(*)::int`,
            withClickId: sql<number>`(count(*)
              filter (where ${conversations.ctwaClid} is not null))::int`,
            won: sql<number>`(count(*) filter (where ${stages.kind} = 'success'))::int`,
            paidTotal: sql<string>`coalesce(sum((
              select coalesce(sum(o.amount), 0) from orders o
              where o.conversation_id = ${conversations.id}
                and o.status = 'paid'
                and o.currency = ${currency}
            )), 0)::numeric(16,2)::text`,
          })
          .from(conversations)
          .leftJoin(stages, eq(stages.id, conversations.stageId))
          .where(
            and(
              eq(conversations.agentId, agentId),
              gte(conversations.createdAt, since),
              or(isNotNull(conversations.adSourceId), isNotNull(conversations.ctwaClid)),
            ),
          )
          .groupBy(conversations.adSourceId)
          // Biggest ad first, and the id breaks a tie so two equal sources do not swap
          // places between two reloads of the same screen.
          .orderBy(sql`count(*) desc, ${conversations.adSourceId} asc nulls last`),

        /**
         * The money, and the size of the cohort that produced it.
         *
         * Every figure here is computed in Postgres and leaves it as characters. The
         * reasons, because the next reader will want to widen or narrow one of them:
         *
         * - `sum(numeric)` returns `numeric` — arbitrary precision, exact, no float
         *   anywhere in the aggregate. (`sum(int)` returns `bigint`; only `sum(float8)`
         *   is a double.)
         * - The cast is **wider than the column** on purpose. An amount is
         *   `numeric(14,2)`, so it stops just under 10^12, but a handful of them add past
         *   that — and `::numeric(14,2)` on the total would raise `numeric field
         *   overflow`, which fails the whole request rather than one card. `board.ts` made
         *   the same choice for the same reason.
         * - `::text` makes the value characters before the driver sees it, so nothing here
         *   relies on how `pg` happens to decode `numeric`.
         * - `round(numeric, int)` is exact decimal rounding, not float rounding.
         * - `nullif` rather than a guard in Node: no leads yields `null`, where
         *   `coalesce(…, 0)` would print «0 ₸ с лида» about a period in which nothing was
         *   sold to nobody.
         *
         * The currency is in the predicate and not assumed, the clause `board.ts` carries:
         * `orders.currency` is a per-row column, and an amount in another currency added
         * into this sum would be a number labelled with a unit it is not in. Those orders
         * are counted into `otherCurrencyOrders` so the exclusion is visible rather than
         * merely missing.
         */
        db
          .select({
            paidOrders: sql<number>`(count(*)
              filter (where ${orders.currency} = ${currency}))::int`,
            paidTotal: sql<string>`coalesce(
              sum(${orders.amount}) filter (where ${orders.currency} = ${currency}),
              0)::numeric(16,2)::text`,
            averageOrder: sql<string | null>`round(
              avg(${orders.amount}) filter (where ${orders.currency} = ${currency}),
              2)::numeric(16,2)::text`,
            revenuePerLead: sql<string | null>`round(
              (sum(${orders.amount}) filter (where ${orders.currency} = ${currency}))
                / nullif((${newLeadsSql}), 0),
              2)::numeric(16,2)::text`,
            otherCurrencyOrders: sql<number>`(count(*)
              filter (where ${orders.currency} <> ${currency}))::int`,
            newLeads: sql<number>`(${newLeadsSql})::int`,
            leadsFromAds: sql<number>`(select count(*) from ${conversations}
              where ${conversations.agentId} = ${agentId}
                and ${conversations.createdAt} >= ${sinceText}::timestamptz
                and (${conversations.adSourceId} is not null
                     or ${conversations.ctwaClid} is not null))::int`,
          })
          .from(orders)
          .where(
            and(
              eq(orders.agentId, agentId),
              eq(orders.status, 'paid'),
              gte(orders.paidAt, since),
            ),
          ),
      ]);

      // Both rows are certain: an aggregate with no `group by` returns exactly one row,
      // even over no rows at all — which is the case this route has to recognise rather
      // than mistake for an absent answer.
      const counters = counterRows[0]!;
      const totals = moneyRows[0]!;

      /**
       * The chain, or nothing at all when nothing moved.
       *
       * Empty exactly when the window holds no transition: a chain of zeros would read as
       * «ни один лид никуда не дошёл», while the truth is that the cabinet was not asked to
       * move anybody. The screen says which of the two it is looking at, and it can only do
       * that if the two are told apart here.
       *
       * No monotonic closure anywhere in this loop. A lead dragged from «Новый лид» to
       * «Продажа» entered two stages and no others; counting it into the three between them
       * would print a funnel that never happened, and would be exactly wrong for a funnel
       * whose last position is a refusal.
       */
      const funnel: FunnelStep[] =
        counters.moves === 0
          ? []
          : funnelRows.map((row, index): FunnelStep => {
              // Certain: `index > 0` means the array has an element before this one.
              const previous = index === 0 ? null : funnelRows[index - 1]!;
              return {
                stageId: row.stageId,
                name: row.name,
                kind: row.kind as StageKind,
                position: row.position,
                entered: row.entered,
                // Integers divided in Node, because a ratio is not money. Null on the first
                // step, and null — never 0 — when the previous step has no entries at all:
                // nothing to divide by is not zero per cent.
                conversion:
                  previous === null || previous.entered === 0
                    ? null
                    : row.entered / previous.entered,
              };
            });

      // `null` rather than a row of zeros, which is `AiUsage.total`'s rule for
      // `AiUsage.total`'s reason: zeros read as a fact about the business, while the
      // absence of any paid order is not one. The screen says which absence it is looking
      // at instead of printing 0 ₸.
      const money: StatsMoney | null =
        totals.paidOrders === 0
          ? null
          : {
              paidOrders: totals.paidOrders,
              paidTotal: totals.paidTotal,
              averageOrder: totals.averageOrder,
              revenuePerLead: totals.revenuePerLead,
              otherCurrencyOrders: totals.otherCurrencyOrders,
            };

      return {
        period,
        since: since.toISOString(),
        // Carried even though the funnel is the only part of this answer it governs: the
        // sources and the money are honest back to the day the number was connected, and
        // the screen has to be able to say which of the three cards starts on this date
        // rather than leave the reader to assume they all do.
        stageHistorySince: req.agent!.stageHistorySince.toISOString(),
        funnel,
        failureEntries: counters.failureEntries,
        backwardMoves: counters.backwardMoves,
        deletedStageEntries: counters.deletedStageEntries,
        deletedStageNames: counters.deletedStageNames,
        newLeads: totals.newLeads,
        leadsFromAds: totals.leadsFromAds,
        sources: sourceRows.map(
          (row): StatsSource => ({
            sourceId: row.sourceId,
            sourceType: row.sourceType,
            headline: row.headline,
            leads: row.leads,
            withClickId: row.withClickId,
            won: row.won,
            paidTotal: row.paidTotal,
          }),
        ),
        money,
        currency,
      };
    },
  );
}
