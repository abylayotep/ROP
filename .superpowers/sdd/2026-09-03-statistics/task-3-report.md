# Task 3 — The shared period, and the snapshot endpoint

**Status:** done. `npm --prefix server test` 766 passed (48 files), `npm --prefix server run
typecheck`, `npm --prefix rakurs run typecheck` and `npm --prefix rakurs run build` all green.

## What landed

| File | Change |
|---|---|
| `server/src/lib/period.ts` | New. `PERIOD_DAYS`, `DAY_MS`, `periodQuery`, `periodSince`. |
| `server/src/api/ai.ts` | Imports them; its own copies are gone. |
| `server/src/api/stats.ts` | New. `registerStatsRoutes`, `GET /api/agents/:agentId/stats/current`. |
| `server/src/api/server.ts` | Registers it beside `registerBoardRoutes`. |
| `packages/contract/index.ts` | New `Статистика` section: `Period`, `StageStanding`, `StatsCurrent`; `AiUsagePeriod = Period`. |
| `rakurs/src/api/index.ts` | `getStatsCurrent(agentId, signal)`. |
| `server/test/stats-current.test.ts` | New, 8 tests. |

## The extraction changed nothing

`server/test/ai-usage.test.ts` is untouched and passes — 11 tests. The diff on `api/ai.ts` is
five lines added and eighteen removed: the import, the two call sites, and the deletion of
`PERIOD_DAYS`, `DAY_MS` and the inline `z.enum`. The window arithmetic
(`Date.now() - days * DAY_MS`), the query schema and the 400 «Неизвестный период» moved
verbatim, so the boundaries, the parsing and the refusal are the same values in a different
file. `grep` confirms no `PERIOD_DAYS`, `DAY_MS` or period enum is left in `api/ai.ts`.

`AiUsagePeriod` is kept as a name and redefined as `Period`, so the AI screen's imports did
not move.

## The snapshot

Two statements in one `Promise.all` — the agent's stages by `position`, and
`select stage_id, count(*)::int … group by stage_id` — assembled in Node. The bucket map is
seeded from the stages, so every current stage appears with a zero rather than being absent;
a `stage_id` that is null, or that names a stage no longer in the funnel, falls into
`unsorted`. `total` is summed from those same buckets, never a third `count(*)`.
`stageHistorySince` is `req.agent!.stageHistorySince` — task 1's column, which had landed as
`a818640` before this commit.

No period on this route, deliberately: it counts every conversation the cabinet has ever had,
including the ones triaged before movement was recorded, which is exactly what a window would
hide.

## Notes

- The worktree had no `node_modules`, so `@rakurs/contract` was resolving up the directory
  chain to the **main checkout's** copy — a typecheck here was silently reading another
  worktree's contract. `npm install` at the worktree root fixed it; `package-lock.json` is
  unchanged. Worth knowing for any later agent in a fresh worktree.
- Nothing was staged outside the seven files above. `server/src/db/schema.ts` and
  `server/drizzle/` are task 1's and were not touched; no migration was generated.
- 766 is the whole branch after task 1; this task contributes 8 of them.
