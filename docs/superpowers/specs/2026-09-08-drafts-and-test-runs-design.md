# Drafts and test runs

**Date:** 2026-09-08
**Status:** Approved. Ready for implementation planning.
**Stage:** 8 of the pleep-model rebuild, part 3 of 3. Consumes
[the knowledge base as a vault](2026-09-08-obsidian-knowledge-base-design.md) and
[agent coaching](2026-09-08-agent-coaching-design.md).

## Goal

Nothing the coach proposes reaches the store the agent answers from until it has been played
against real conversations and a person has looked at the result. A change becomes a
**draft**; the draft is **run** over a set of test conversations with the change applied; the
owner reads «было — стало» and pushes, or throws it away.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Granularity | One draft per change | When a run goes wrong, the owner must know which change did it. A branch holding ten edits answers "something broke" and nothing more. |
| Where a run happens | The existing sandbox: a real model call inside a transaction that is rolled back | It already exists in `server/src/lib/ai/turn.ts`, it already produces exactly what a live customer would get, and it already leaves nothing behind. Applying the draft's operations inside that transaction is the whole trick. |
| Where test cases come from | A saved set per agent, grown by hand, pulled from live dialogs, and offered by the model | A set that persists is what makes the second change cheaper than the first. Generation alone tests a different thing every time; live dialogs alone leave a new account with nothing to run. |
| Who judges | The owner. The model annotates | A verdict is an opinion, and «хуже» is sometimes the point. The button stays under a hand. |
| «Было» | Reused across runs, keyed by a config version | Otherwise every run pays twice for a half of the table that did not change. |
| Applying a stale draft | Refused | A draft is a promise that what was tested is what lands. If a note it edits moved underneath it, the promise is void. |

## Data model

Migration `0014`.

```
kb_drafts     id, agent_id fk→agents cascade, title text,
              origin text, status text, ops jsonb,
              base jsonb, created_by fk→users set null,
              created_at, applied_at
              index (agent_id, status, created_at)

test_cases    id, agent_id fk→agents cascade, title text,
              messages jsonb, expectation text, origin text,
              conversation_id fk→conversations set null,
              enabled boolean default true,
              created_at, updated_at
              index (agent_id, enabled)

test_runs     id, agent_id fk→agents cascade,
              draft_id fk→kb_drafts cascade,      -- null = baseline
              config_version integer, model text,
              status text, cost numeric(12,8),
              started_at, finished_at
              index (agent_id, draft_id, started_at)
              index (agent_id, config_version) where draft_id is null

test_results  id, run_id fk→test_runs cascade,
              case_id fk→test_cases cascade,
              reply text, used_chunk_ids jsonb, stage_id uuid,
              handoff boolean, handoff_reason text,
              outcome text, cost numeric(12,8),
              verdict text, verdict_reason text,
              created_at
              unique (run_id, case_id)
```

`agents` gains `config_version integer not null default 1`, and `coach_messages` gains
`draft_id fk→kb_drafts set null` — the column [part 2](2026-09-08-agent-coaching-design.md)
describes and this migration is the first that can create.

**`ops`** is the change, as a list. Each entry mirrors a coach proposal:
`{ op: 'note_create', path, body }`, `{ op: 'note_update', noteId, body }`,
`{ op: 'rule_create', category, text }`, `{ op: 'rule_update', ruleId, text?, enabled? }`.
A draft made from the coach holds exactly one; the shape is a list because applying one and
applying three is the same code and the difference is not worth a second table.

**`base`** is what the draft was built on: `{ notes: { <noteId>: <updatedAt> }, rules: {
<ruleId>: <updatedAt> } }` for every row the ops touch. It is what makes a stale draft
detectable.

**`status`** is `open` → `applied` | `discarded`. A draft is applied once; `applied_at` and
the ops stay for the record.

**`messages`** on a case is the customer's side only: `["Здравствуйте", "сколько стоит
доставка в Астану"]`. The agent's replies are what we are testing, so storing them in the
case would be storing the answer in the question.

**`expectation`** is free text — «должен назвать 1500 ₸», «не должен обещать скидку». It is
shown to the owner and given to the annotating model. It is not a machine assertion: turning
it into one is the "auto verdicts" feature we are not building.

### The config version

`agents.config_version` increments on every write that changes what the agent would say: a
note created, saved or deleted; an import or a refresh; a rule created, edited, reordered,
enabled, disabled or deleted; a draft applied. One helper, `bumpConfigVersion(tx, agentId)`,
called inside the same transaction as the write it describes — a version that lags its data
is worse than no version, because it makes a stale baseline look fresh.

Model and temperature are part of the identity of a baseline too, so `test_runs.model`
records the model a run used and a baseline is reusable only if the model matches.

## Running

`POST /api/agents/:agentId/drafts/:draftId/runs` with the case ids to run.

For each case, in sequence:

1. Open a transaction.
2. Apply the draft's ops inside it — the same functions the apply path uses, so a run tests
   the code that will land, not a parallel implementation of it.
3. Feed the case's customer messages through the existing sandbox turn, one message at a
   time, carrying the agent's own replies forward as history, so a three-message case tests
   a conversation and not three unrelated questions.
4. Record `reply`, `used_chunk_ids`, `stage_id`, `handoff`, `outcome`, `cost` into
   `test_results`.
5. Roll back.

Nothing is sent to WhatsApp, no lead moves, no field is written — the same guarantees the
sandbox already makes, from the same mechanism.

**The baseline.** «Было» is a run with `draft_id = null` at the agent's current
`config_version` and model. Before running a draft, the server looks for a baseline result
per case at that version; a case with one costs nothing, a case without one is run against
the unmodified store in the same pass and its result stored as the baseline for reuse. So
the first run over a fresh set of cases costs two calls per case and every run after it
costs one, until the owner changes something — which is exactly when the baseline should
expire.

**The annotation.** After the results are in, one model call per case compares «было»,
«стало» and the expectation and returns `verdict` ∈ `better` | `worse` | `same` and one
line of reasoning. It is a hint in a column. It gates nothing, and a run whose annotation
call fails is still a complete run with empty verdicts.

**Limits**, matching the sandbox: at most 20 cases in a run, three runs in flight per
account, 20 runs a minute, a case's messages at most 4000 characters each and at most 10 of
them. Runs are owner-only. A run in `status = 'running'` blocks a second run of the same
draft.

**Money is stated before it is spent.** The run button's confirmation names the arithmetic:
«14 проверок: 14 вызовов (базовые взяты из прошлого прогона) плюс 14 сравнений». Cost is
summed from what OpenRouter reports, the same way `ai_replies` does it, and shown on the run.

## Applying

`POST /api/agents/:agentId/drafts/:draftId/apply`, owner-only, in one transaction:

1. Refuse unless the draft has at least one finished run at the agent's **current**
   `config_version`. A run against a store that has since changed proves nothing.
2. Compare `base` against the rows now: any note or rule whose `updatedAt` moved, or that was
   deleted, refuses the apply with «Заметка изменилась после проверки — прогоните заново».
3. Apply the ops. Notes go through the same save path as the editor, so chunks and links are
   rebuilt exactly as they would be.
4. Bump `config_version`, set `status = 'applied'` and `applied_at`.

Discarding is `POST …/discard`: `status = 'discarded'`, nothing else touched.

Applying a draft invalidates every baseline, by construction — the version moved. That is
correct and cheap: the next draft's first run re-establishes the baselines it needs and no
others.

## Test cases: filling the set

- **By hand.** «Добавить проверку»: a title, the customer's messages, an expectation.
- **From a dialog.** `DialogsScreen` gains «В проверки» beside «Так нельзя». It copies the
  customer's messages from that conversation — up to ten — and links `conversation_id`.
- **Generated.** On a draft's run screen, «Придумать проверки» asks the model for five to ten
  customer questions aimed at what the draft changes. They come back as a checklist: keep in
  the set, run once, or drop. Nothing is saved without a tick. Generation is a model call and
  is priced like the rest.

Disabled cases stay in the set and are not run — a case that has served its purpose should be
switchable, not deleted, because deleting it loses the baseline with it.

## Screens

A new `DraftScreen.tsx`, reached from a coach card or from a drafts list on «Обучение»:

- **The change**, rendered as a diff: for a note, old body against new; for a rule, its
  category and text.
- **The cases**, checkboxes, defaulting to every enabled case, with «Придумать проверки».
- **Run**, with the cost sentence above it.
- **The table**: case, «было», «стало», the sections the agent used, whether it handed off,
  and the model's verdict with its one line. A row expands to the full text of both replies.
- **«Применить»** and **«Отбросить»** under the table. «Применить» is enabled once a run at
  the current version exists — red verdicts do not disable it, and a stale draft explains
  itself in words rather than greying out silently.

A «Проверки» tab holds the set itself: list, add, edit, enable, delete.

## Tests

- Applying ops inside a rolled-back transaction leaves the store byte-identical, including
  chunks, links and `config_version`.
- A multi-message case carries history: the second question is answered in the context of the
  first reply.
- Baseline reuse: same version and model reuses; a bumped version does not; a changed model
  does not.
- `bumpConfigVersion` fires on every listed write, and on none that only reads.
- Apply refuses with no run, with a run at an older version, and with a moved `updatedAt`;
  succeeds and bumps the version otherwise.
- Apply is idempotent in the safe direction: a second apply of an applied draft is refused,
  not replayed.
- A failed annotation call leaves results with null verdicts and a complete run.
- Limits: the 21st case, the fourth concurrent run, a case with 11 messages.
- Permissions: a member gets 403 on drafts, runs and cases.
- Cost is summed from what the client reports and is zero, not null, for a model that reports
  none — the same rule `ai_replies` follows.

## Not in this stage

- **Machine-checked expectations.** The expectation is prose for a person and a hint for the
  annotator. Turning it into an assertion is a feature with its own grammar.
- **Scheduled regression runs.** A nightly run over the whole set is easy to add later and
  spends the owner's money while they sleep, which needs asking first.
- **Draft stacking.** One draft is applied against the live store, not onto another draft.
- **Rollback of an applied draft.** The ops are stored, so an undo is possible later; getting
  it right needs the note history the vault spec deliberately postponed.
