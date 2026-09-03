# Task 2 — Record every move

**Status:** done. `npm --prefix server test` 777 passed / 49 files (baseline 766 + 11 new),
`npm --prefix server run typecheck` clean, migration count unchanged at 0011.

## Every path that writes `conversations.stage_id`

I searched three ways — `grep stageSetBy`, `grep 'update(conversations)'` with context, and
`grep 'stageId:'` across `server/src` — and then followed the frontend callers back to the
routes they hit. The complete list:

| # | Path | Moves a stage? | Wired |
|---|---|---|---|
| 1 | `PATCH /api/agents/:agentId/conversations/:conversationId/lead` — `server/src/api/leads.ts` | yes, `stage_set_by = 'operator'` | **yes**, `movedBy: 'operator'` |
| 2 | `runTurn` — `server/src/lib/ai/turn.ts` | yes, `stage_set_by = 'ai'` | **yes**, `movedBy: 'ai'` |
| 3 | `runTurn` dry-run branch (`server/src/lib/ai/turn.ts`, the `else if (dryRun)` arm) | no — sets `movedTo` only | deliberately **not** wired, pinned by a test |
| 4 | `DELETE /api/agents/:agentId/stages/:stageId` — `server/src/api/stages.ts` | no — refuses with 409 while any conversation holds the stage, so it can never null one out | n/a |
| 5 | `POST /api/agents/:agentId/stages/order` — `server/src/api/stages.ts` | no — writes `stages.position`, never touches a conversation | n/a |
| 6 | `insert(conversations)` in `lib/whatsapp/inbound.ts` and `api/ai.ts` | no — a new conversation takes no stage; `stage_id` starts null | n/a |

The two frontend paths the brief warned about — the board's drag
(`rakurs/src/screens/BoardScreen.tsx:86`) and the lead card's stage picker
(`rakurs/src/components/lead/LeadPanel.tsx:102`) — both call `api.setLeadStage`
(`rakurs/src/api/index.ts:183`), which is the single PATCH in row 1. They are two buttons on
one server path, not two paths, so wiring `leads.ts` covers both. The other `update(conversations)`
callers (`funnel-message.ts`, `api/conversations.ts`, `api/ai.ts`, `lib/whatsapp/inbound.ts`,
`turn.ts`'s handoff and delivery writes) touch `last_message_at`, `ai_enabled` or the ad columns
and never the stage.

## The writer — `server/src/lib/funnel-history.ts`

`recordStageMove(db: Executor, input)` exactly as the plan specifies. Three things it does not do:

- **It does not open a transaction.** It takes `funnel.ts`'s `Executor`, so it lands or fails
  with the `UPDATE` that moved the stage.
- **It does not catch.** The doc comment argues this against its two neighbours, `queueLead`
  and `sendStageMessage`, which swallow everything: those are reports to somebody else's system
  over the network, made after the operator's action already happened, and a failed consequence
  must not undo its cause. This one *is* the record of the cause, it is one insert into our own
  table in a transaction already open, and the only way it fails is a broken database — in which
  case the move was doomed anyway. A history with silent gaps yields conversion numbers that are
  wrong and unfalsifiable.
- **It does not stamp `occurred_at`.** The column default does, so the row is timed by the
  statement batch that moved the stage rather than a `new Date()` made earlier in the request.

## The operator's path

The call sits **inside** the existing `db.transaction`, immediately after the guarded UPDATE,
gated on `rows.length > 0`. The stage validation query changed shape: it selected `{ id }` for
the target alone and now selects `id, name, kind, position` for the target **and** the stage
being left, in one statement — `inArray` when the lead has a current stage, plain `eq` when it
does not. `loadLead` hands back `stageId` and nothing else about the stage, and a second round
trip would be one more wait on every drag across the board.

`movedByUserId` is `req.user!.id` — `require-session.ts` attaches the whole user row as
`req.user`, not a `req.session`.

**A patch that clears the stage (`stageId: null`) records nothing,** and this is a decision, not
an omission: `recordStageMove`'s `to` is non-nullable because a lead taken out of the funnel has
not entered any stage and there is no column for the report to count it into. The move is still
visible on the lead card through `stage_set_at`. There is a test for it.

The comment block warning that the AI path is a copy now lists four things: the guarded UPDATE,
the recorded transition, the auto-message, the queued conversion.

## The agent's path

Beside `queueLead` and `sendStageMessage`, inside the `stageMoved.length > 0` arm, and **first**
of the three: the record of the move comes before reporting it to Meta and before saying anything
to the customer. `from` is `stageRows.find(...)` — the agent's whole funnel is already loaded to
build the prompt, so this costs no query. The `dryRun` branch is untouched and writes nothing.

## Tests — `server/test/stats-record.test.ts`, 11 of them

Both writers are driven through their real entry points (`app.inject` and `runTurn`), never by
calling `recordStageMove` directly: what is worth testing is not the insert but the four places a
row must *not* appear.

Operator: a move writes one row with both stages snapshotted, `moved_by = 'operator'` and the
session's user id; a first stage writes `from_stage_id` / `from_name` / `from_position` null; a
backwards move is recorded like any other with `to_position < from_position`; a patch naming the
stage the lead is already in writes none; an assignee-only patch writes none; clearing the stage
writes none; and two concurrent patches from the same read stage write exactly one row between
them — the forced race `leads-api.test.ts` already uses, where a second writer holds the row under
`for update` while the request blocks on its own write.

Agent: a `runTurn` move writes one row with `moved_by = 'ai'` and `moved_by_user_id` null; a
**sandbox turn writes none** while still returning `stageId` in its result and leaving the
conversation's stage where it was; a model naming the current stage writes none; a turn that moves
nothing writes none.

`server/test/helpers/db.ts` now names `stage_transitions` in its truncate list. The `cascade`
already reached it through `conversations`, so this changes no behaviour — it makes the table
visible to the next person reading the fixture.

## Concerns

1. **`turn.ts` has no transaction to join.** The operator's move runs inside `db.transaction`;
   the agent's is a bare `db.update` followed by the record. So on the AI path the two statements
   are not atomic — a crash between them leaves a move with no row. The plan asks for the call
   "after `stageMoved.length > 0`, beside `queueLead` and `sendStageMessage`", which is what I
   did; wrapping that arm in a transaction would be a change to stage 5's write path and is out of
   this task's scope. Worth a look if the funnel ever shows fewer AI moves than `stage_set_by`
   says there were.
2. **Nothing records a stage being cleared.** See above — a deliberate consequence of the plan's
   non-nullable `to`. If task 4's report ever needs to explain a lead that left the funnel, the
   table cannot say when.
3. Nothing reads `stage_transitions` yet, as required.
