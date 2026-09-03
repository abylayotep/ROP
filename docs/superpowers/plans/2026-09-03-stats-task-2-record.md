# Task 2 — Record every move

**Depends on:** task 1.
**Blocks:** task 4 — a funnel query tested against rows nothing produces proves nothing.

## Why

Two places write `conversations.stage_id`, and they are deliberate copies of one another:
`api/leads.ts` for an operator and `lib/ai/turn.ts` for the agent. Both already carry the same
comment saying a change to one has to be made to the other. This task adds the third thing
both of them do.

## The writer

- [ ] New `server/src/lib/funnel-history.ts`:

```ts
export async function recordStageMove(
  db: Executor,
  input: {
    agentId: string; conversationId: string;
    from: { id: string; name: string; position: number } | null;
    to:   { id: string; name: string; kind: string; position: number };
    movedBy: 'operator' | 'ai' | 'scenario' | 'system';
    movedByUserId?: string | null;
  },
): Promise<void>
```

- [ ] `Executor` is the type `lib/funnel.ts` already exports — a connection or an open
  transaction. The helper never opens its own: it has to land or fail together with the
  `UPDATE` that moved the stage.
- [ ] **No try/catch.** A failure propagates and rolls the move back. Comment it against the
  neighbouring CAPI hook, which swallows on purpose: that one is a report to somebody else's
  system and the operator's action has already happened; this one is the record of that action,
  and a history with silent gaps produces conversion numbers that are wrong and unfalsifiable.
- [ ] `occurredAt` is left to the column default, so the row is stamped by the same statement
  batch that moved the stage rather than by a `new Date()` the caller made earlier.

## The operator's path — `server/src/api/leads.ts`

- [ ] Inside the existing `db.transaction`, immediately after the guarded `UPDATE`, when
  `rows.length > 0`. Not after the transaction: the two must commit together.
- [ ] The `from` comes from `current` — the lead this request read — and is `null` when
  `current.stageId` is null. `loadLead` returns `stageId` but not the stage's name, kind and
  position; load them together with the target stage rather than adding a second round trip.
- [ ] The target stage is already validated against this agent; select `name`, `kind` and
  `position` in that same statement instead of `{ id }` alone.
- [ ] `movedBy: 'operator'`, `movedByUserId: req.session.userId` (whatever `require-session.ts`
  names it).
- [ ] Extend the existing comment block that warns the AI path is a copy: it now lists three
  things — the guarded UPDATE, the auto-message, the queued conversion — plus the transition.

## The agent's path — `server/src/lib/ai/turn.ts`

- [ ] After `stageMoved.length > 0`, beside `queueLead` and `sendStageMessage`.
- [ ] `stageRows` is already loaded, so `from` and `to` come from it with no extra query.
- [ ] `movedBy: 'ai'`, `movedByUserId: null`.
- [ ] The `dryRun` branch that only sets `movedTo` must not call it. Add a test rather than
  trusting the shape: the sandbox rolls back, but a helper called there would still hold a
  connection and change the row count a reader sees mid-transaction.

## Tests — `server/test/stats-record.test.ts`

- [ ] An operator PATCH that moves a lead writes exactly one row: right `from`/`to` ids and
  snapshots, `moved_by = 'operator'`, `moved_by_user_id` the session's user.
- [ ] A lead's very first stage writes a row with `from_stage_id` and `from_name` null and the
  right `to`.
- [ ] A PATCH naming the stage the lead is already in writes none.
- [ ] Two concurrent PATCHes from the same read stage write exactly one row between them —
  the same test shape `leads-api.test.ts` already uses for the lost-race auto-message.
- [ ] The agent's move through `runTurn` writes one row with `moved_by = 'ai'` and no user.
- [ ] A sandbox turn that would move a stage writes none.
- [ ] A move backwards — to a stage with a lower `position` — writes a row like any other.
  Nothing rejects it; the report will count it.
- [ ] A PATCH that only changes the assignee writes none.

## Acceptance criteria

- [ ] `npm --prefix server test` and `npm --prefix server run typecheck` are green, including
  the existing `leads-api`, `ai-turn` and `funnel-message` suites unchanged.
- [ ] Every path that writes `conversations.stage_id` in the repository now also records a
  transition. Grep for `stageSetBy` and confirm there is no third writer.
- [ ] Nothing reads `stage_transitions` yet.

## Before task 4 starts

Rows appear for real moves and only for real moves, so the funnel query in task 4 can be
tested by moving leads through the API rather than by inserting rows by hand.
