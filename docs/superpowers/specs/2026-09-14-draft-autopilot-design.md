# Draft autopilot: one button that tests, fixes and applies a draft

Started on: Opus 5 · Subtasks: Opus 5 (session model governs every subagent)

## Problem

A knowledge-base draft today needs an owner to drive five manual steps: tick cases (or ask
for suggestions and save them one by one), start a run, read a table of verdicts, rewrite
or remove the topics that made answers worse, run again, then press «Применить». On the
first real draft (2026-09-14, agent `c6d5bba9…`) the owner could not tell why buttons did
nothing, and a run with nine `better`, two `same` and one `worse` still left them guessing
what to do with the one `worse`. They asked for one button that does all of it.

A second problem the run never catches: generated topics can hold raw chat lines (a
manager's question to a customer, emojis, mixed Russian and Kazakh inside «Факты»). The
judge compares answers, so a topic the agent simply does not use passes clean.

## Decisions taken with the owner

1. The button ends by **applying the draft itself** when the final run has no `worse`
   verdict and the server's own `isDraftApplicable` agrees. Otherwise it stops and says why.
2. A topic rewritten **twice** whose case is still `worse` is **removed** from the draft, and
   the rest is applied if nothing else is `worse`.
3. Cases = the owner's ticked, enabled cases, **topped up** with suggested cases (saved)
   when there are fewer cases than note topics. Never more than 20 (`MAX_CASES`).
4. A **clean-up pass** over every note topic runs once, before the first run.
5. Hard cap: **4 draft runs** per autopilot.
6. Runs on the server and survives a closed page and a redeploy.

## Non-goals

- No change to how a single run replays or judges a case (`runReplay`, `annotate`).
- Rule ops (`rule_create`, `rule_update`) are never rewritten or removed by the autopilot.
  A `worse` case can only be pinned to a note (see Attribution), so rules are out of reach.
- No new cost limit beyond the run cap. Spend is shown, not budgeted.
- Manual flow stays as it is: «Запустить прогон», «Применить», «Отбросить», topic edits.

## Attribution: which topic made a case worse

`test_results.used_chunk_ids` holds the note ids the reply was built from. For `note_update`
ops that is the real note id. For `note_create` ops the note exists only inside the replay
transaction that is rolled back, so its id is random and lost.

`applyOps` already reports `(opIndex, noteId)` through `onNoteApplied`. `replayCase` will pass
that callback, build `noteId → opIndex`, and return `usedOpIndexes: number[]` — the op
indexes of the draft's notes the last turn used, deduplicated, ascending. A new column
`test_results.used_op_indexes integer[] not null default '{}'` stores it (baseline rows keep
`{}`). `TestCaseSide` in `packages/contract/index.ts` gets `usedOpIndexes: number[]`.

Side benefit: `RunTable` labels draft notes by the op's own title (`path` for
`note_create`, `base.noteNames[noteId]` for `note_update`) instead of «новая заметка
черновика», which today truncates to «новая заметка ч…» in every row.

Op indexes shift when an op is removed, so attribution is only ever read from the run that
just finished against the ops the autopilot recorded when it started that run
(`draft_autopilots.run_ops`), never against a later version of the draft.

Topic identity across rewrites and removals uses a stable key, not an index:
`note_create` → `path:<path>`, `note_update` → `note:<noteId>`.

## Data model

Migration `0046_draft_autopilot.sql` (next free number; check `server/drizzle/meta/_journal.json`).

```sql
alter table test_results add column used_op_indexes integer[] not null default '{}';

create table draft_autopilots (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references agents(id) on delete cascade,
  draft_id uuid not null references kb_drafts(id) on delete cascade,
  created_by uuid not null references users(id),
  status text not null,            -- running | applied | stopped | cancelled
  step text not null,              -- prepare_cases | clean_topics | start_run | await_run | fix_topics | apply
  case_ids uuid[] not null default '{}',
  run_id uuid references test_runs(id) on delete set null,
  run_ops jsonb,                   -- draft.ops as they were when run_id started
  runs_started integer not null default 0,
  run_failures integer not null default 0,
  noise_retry_used boolean not null default false,
  topic_attempts jsonb not null default '{}',   -- { "<topic key>": rewrites so far }
  pending_fixes jsonb,             -- computed by await_run, consumed by fix_topics
  log jsonb not null default '[]', -- [{ at, kind, text }], Russian, shown to the owner
  cost numeric(12,6) not null default 0,
  stop_reason text,                -- Russian, shown to the owner
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);
create unique index draft_autopilots_one_running on draft_autopilots (draft_id) where status = 'running';
create index draft_autopilots_running on draft_autopilots (status) where status = 'running';
```

Match the column types the existing tables use (check `test_runs.cost` for the numeric type
and the `users` / `agents` references in `db/schema.ts`), and add the Drizzle table to
`db/schema.ts` plus the generated snapshot.

`log.kind` is one of `info | fix | remove | warn`. The log keeps at most 50 entries.

## Engine: one step per tick

`server/src/lib/drafts/autopilot.ts` exports `advanceAutopilot(db, deps, id)` and
`drainAutopilots(db, deps)`. `index.ts` calls `drainAutopilots` every 5 s with the same
`running` flag guard the CRM and Kaspi timers use. Each call to `advanceAutopilot` loads the
row, the draft and the agent fresh, performs **one** step, and writes the next `step` in the
same update. That is what makes a restart safe: the row is the whole state.

Before any step: if the draft is no longer `open`, stop with «Черновик уже применён или
отброшен». If the agent has no OpenRouter key, stop with «Нет ключа OpenRouter».

### `prepare_cases`
- Start from `case_ids` (sent by the owner), keep only the agent's enabled cases, add the
  required correction case if the draft has one (as the run route does).
- Count note ops. If the case count is below that, call `suggestCases` once, insert the
  suggestions as `test_cases` with `origin = 'suggested'` (check that value is allowed; add it
  to any enum/check if one exists), until the total reaches `max(noteOps, current)`, capped at
  20. Log «Добавлено N проверок».
- No cases at all after this → stop «Не из чего собрать проверки».
- Next: `clean_topics`.

### `clean_topics`
- For every note op, call `cleanTopic` (below). An unchanged body is skipped. A changed body
  is written through the shared op-edit function (`action: 'update'`). Log per topic
  «Почищена тема „<title>“: <short reason>».
- A failed model call for one topic logs `warn` and keeps the original body; it never stops
  the autopilot.
- Next: `start_run`.

### `start_run`
- `runs_started >= 4` → stop «Не удалось добиться результата за 4 прогона».
- Call the shared `startDraftRun` with `case_ids`. On success store `run_id`, `run_ops =
  draft.ops`, `runs_started + 1`, log «Прогон N из 4».
- `429` (no turn slot) or `409` «уже проверяется» → stay on `start_run`, try next tick.
- Any other `ApiError` → stop with its message.
- Next: `await_run`.

### `await_run`
- Run `running` → stay.
- Run `failed` (or `run_id` null because it was deleted) → `run_failures + 1`; at 3 stop «Прогон
  трижды оборвался»; otherwise back to `start_run` (the failed run still counts toward 4).
- Run `done` → add its cost and its paired baseline cost to `cost`, then evaluate:
  - `bad` = results with `verdict = 'worse'`, plus the required correction case when its
    verdict is not `better` or its outcome is not sent/applied/handoff.
  - No `bad` and `isDraftApplicable` → `apply`.
  - No `bad` but not applicable (store moved under the draft) → `start_run`.
  - `bad` present: for each bad result map `usedOpIndexes` through `run_ops` to topic keys,
    keeping only note ops that still exist in the current draft.
    - Topics hit: `pending_fixes = [{ key, action: attempts >= 2 ? 'remove' : 'rewrite',
      cases: [{ title, messages, before, after, reason }] }]` → `fix_topics`.
    - Bad results that hit no topic and `noise_retry_used` is false → set it, log `warn`
      «Случай „X“ хуже, но темы черновика в ответе не участвовали — перепроверяем», →
      `start_run`.
    - Bad results that hit no topic and the retry was already used → stop «Случай „X“ стал
      хуже не из-за тем черновика — проверьте его вручную».
    - Both kinds at once: fix the topics; the unattributed ones get re-judged in the next run.

### `fix_topics`
- For each pending fix, find the op by key in the current draft (skip if gone).
- `rewrite` → `rewriteTopic` (below) → op-edit `update`; `topic_attempts[key] + 1`; log `fix`
  «Переписана тема „<title>“: <reason>». A failed rewrite counts as an attempt and logs `warn`.
- `remove` → op-edit `remove`; log `remove` «Убрана тема „<title>“: после двух исправлений
  ответ всё ещё хуже». If it is the last op, stop «Все темы убраны — применять нечего» without
  discarding.
- Clear `pending_fixes`. Next: `start_run`.

### `apply`
- Call the shared `applyDraft`. Success → `status = 'applied'`, `finished_at`, log «Применено».
- `409` → stop with the server's message.

A thrown non-`ApiError` inside a step is logged with `app.log.error` equivalent (pass a
logger in `deps`) and stops the autopilot with «Внутренняя ошибка — попробуйте ещё раз».

## Extracting the shared operations

`api/drafts.ts` keeps the routes but moves three bodies into `lib/drafts/`, behaviour
unchanged, so the routes and the engine run the same code:

- `lib/drafts/run.ts` — `startDraftRun(db, ctx, { agent, draft, caseIds })`, owning
  `runningDrafts`, `runReplay`, the case checks, baseline lookup, admission and detached
  replay. Returns the `TestRun` the route answers with. Exports `isDraftRunning(draftId)`.
- `lib/drafts/apply.ts` — `applyDraft(db, { agentId, draftId })` (the transaction body).
- `lib/drafts/edit-op.ts` — `editDraftOp(db, { agentId, draftId, edit })`.

`ctx` carries `deps: AiDeps`, the credentials `key` and a `log` function. Error text and
status codes stay byte-for-byte what the routes answer today; the existing
`drafts*.test.ts` files are the regression net and must pass unmodified.

## Model helpers

`lib/drafts/topic-fix.ts`, both one call on the agent's own model and key, JSON out, parsed
with zod, never retried, returning `{ body, reason, cost }` or throwing `TopicFixError`:

- `cleanTopic({ title, body })` — remove verbatim customer or manager chat lines, questions
  addressed to a customer, greetings, emojis and anything that is dialogue rather than
  knowledge from «Факты» and free text. «Готовые фразы» may keep reusable replies in any
  language, including Kazakh. Keep every price, amount, phone number, address, bank name,
  schedule and condition exactly. Keep existing `##` headings. Never add information.
  `reason` is one short Russian sentence, empty when nothing changed.
- `rewriteTopic({ title, body, cases })` — given the topic and the cases whose answers got
  worse (customer messages, before, after, judge reason), rewrite the topic so an agent
  reading it answers those cases well: reorganise, clarify, drop the lines that caused the
  bad answer. Same preservation and no-invention rules.

Guards applied to both outputs before anything is written:
- Non-empty, at most `BODY_MAX`, bodies over the generation limit (8k chars) are not sent.
- **No new numbers:** every digit run in the new body must already appear in the old body.
  A violation throws `TopicFixError('invented_number')` — this is the guard against the
  model inventing a price that then reaches customers without a human reading it.

Prompts are English; they tell the model to write the body in the language(s) the topic is
already written in.

## API

All owner-only, under `/api/agents/:agentId/drafts/:draftId/autopilot`:

- `POST` `{ caseIds: string[] }` → `DraftAutopilot`. 409 when one is already running, when the
  draft is not open, or when a manual run is in flight; 409 «Нет ключа OpenRouter» without a
  key. Inserts the row at `prepare_cases` and calls `advanceAutopilot` via `setImmediate` so
  the first step does not wait for the timer. Rate limit as the run route.
- `GET` → the newest autopilot for the draft, or `null`.
- `POST …/cancel` → `status = 'cancelled'`. A run already in flight finishes on its own; the
  engine never starts another.

`DraftAutopilot` (contract): `id, status, step, runsStarted, maxRuns (4), runId, caseIds, log,
cost, stopReason, createdAt, finishedAt`.

While an autopilot is `running`, the manual routes answer 409 «Черновик проверяется
автоматически — остановите проверку, чтобы менять его вручную»: run, apply, discard, op
edit. The engine calls the lib functions directly and is not blocked by this.

## Screen

`DraftScreen.tsx`:
- The action bar's primary button becomes «Проверить и применить» (`btn-accent`); it sends the
  ticked case ids. «Запустить прогон» and «Применить» become plain `btn`s beside it.
- A new `AutopilotPanel` card (in `components/drafts/`) above the action bar whenever the GET
  returns a row: a status line («Идёт: прогон 2 из 4», «Применено», «Остановлено: <reason>»),
  the log newest first, the spend, and «Остановить» while running.
- While running: poll the GET every 3 s; when `runId` changes or the run is polled to done,
  feed that run into `RunTable` and refetch the draft (ops change under the owner). Manual
  buttons, topic edits and the case checkboxes are disabled.
- On `applied`: toast «Черновик проверен и применён» and navigate to
  `../training?tab=review`, like manual apply.
- The hint line under the buttons names the autopilot when nothing is ticked:
  «Нажмите «Проверить и применить» — проверки подберутся сами.» The button is enabled with
  zero ticked cases, since the engine tops them up.

## Testing

Server, vitest against the Docker test database:
- `topic-fix.test.ts`: parse success, malformed JSON, invented-number rejection, unchanged body.
- `autopilot.test.ts` with a fake `ModelClient` scripted per call and a fake replay (inject
  `startDraftRun` / run completion through `deps` so the engine is tested without real turns):
  - happy path: prepare → clean → run → done with no `worse` → applied;
  - `worse` pinned to a topic → rewrite → rerun better → applied;
  - still `worse` after two rewrites → topic removed → applied;
  - last topic removed → stopped, draft still open;
  - unattributed `worse` → one retry → then stopped;
  - four runs used → stopped;
  - failed run (restart) → restarted, counted;
  - cancel mid-run → no further run started;
  - a row left at `await_run` by a "restart" resumes on the next `drainAutopilots`.
- `replay.test.ts` / run tests: `usedOpIndexes` for a `note_create` and a `note_update` op.
- Route tests: POST/GET/cancel, the 409s, manual routes blocked while running.

Frontend, vitest + Testing Library: the button posts ticked ids (and empty), the panel
renders each status, manual controls are disabled while running, `applied` navigates.

## Rollout

One PR to `main`, then `deploy/release.sh`. The migration only adds a column with a default
and a new table. The owner's open draft `f1a4c8b5…` is the first real run after deploy.
