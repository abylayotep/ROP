# Agent coaching

**Date:** 2026-09-08
**Status:** Approved. Ready for implementation planning.
**Stage:** 8 of the pleep-model rebuild, part 2 of 3. Builds on
[the knowledge base as a vault](2026-09-08-obsidian-knowledge-base-design.md); every change
it proposes lands through [drafts and test runs](2026-09-08-drafts-and-test-runs-design.md).

## Goal

Give the owner one screen where they tell the agent what it did wrong, what never to do, and
what the business is — in their own words — and get back a concrete change they can read
before it exists anywhere. Today that conversation has nowhere to happen: a 20 000-character
instruction field is a wall of text nobody re-reads, and a wrong answer in a live dialog
leads nowhere at all.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Shape | A chat on the left, the live list of rules on the right | Dictating is how people think; a list is how they audit. Either alone loses the other half. |
| What the chat produces | A proposal, never an action | The model is guessing what the owner meant. A guess that writes itself into the store the agent answers from is how a business starts promising things it does not sell. |
| Where a proposal goes | Into a draft, not into the store | The draft is run against test conversations first. See part 3. |
| Facts vs behaviour | A fact goes to a note, a behaviour rule goes to the rules list, and the split is enforced in code | A price written into instructions is a price the number guard will accept without a record behind it — the exact hole [`docs/ai-agent.md`](../../ai-agent.md) §1 promises is closed. |
| The old `agents.instructions` field | Replaced. Migrated into rules, column dropped | Two places to write the same instruction is two places to write contradicting ones. |
| The prompt | Assembled from enabled rules, grouped by category | The number guard reads the assembled text exactly as it read the column, so it keeps working unchanged. |
| A wrong answer in a live dialog | A «Так нельзя» button on the agent's message | A rule written from the actual transcript beats a rule written from what the owner remembers of it. |
| Who may coach | The owner | Rules are the agent's character and they cost money to test. Notes stay editable by any member. |

## Data model

Migration `0013`.

```
agent_rules      id, agent_id fk→agents cascade, category text,
                 text text, enabled boolean default true,
                 origin text, position integer,
                 created_at, updated_at
                 index (agent_id, category, position)

coach_messages   id, agent_id fk→agents cascade, role text,
                 text text, proposal jsonb, status text,
                 conversation_id fk→conversations set null,
                 ai_reply_id fk→ai_replies set null,
                 created_at
                 index (agent_id, created_at)
```

`agents.instructions` is read by the migration and dropped by it. `coach_messages.draft_id`,
pointing at `kb_drafts`, is added by migration `0014` in
[part 3](2026-09-08-drafts-and-test-runs-design.md) — the table it references does not exist
yet at `0013`, and a column added a migration later is cheaper than a table defined away from
the spec that owns it.

**`category`** is one of `business`, `tone`, `order`, `forbid` — what we are, how we speak,
what we ask and in what order, what we never do. Four is enough to group the prompt and
short enough that the model picks the right one; a free-form label would drift into forty.

**`text`** is capped at 500 characters. A rule longer than that is a paragraph, and a
paragraph is what the old field was.

**`origin`** is `manual` or `coach` — where the rule came from, shown in the list so the
owner can tell what they wrote from what they approved.

**`position`** orders rules inside a category. Drag to reorder; the prompt follows it.

**`proposal`** is null on the owner's own messages and on the model's plain replies. When
present it is one of:

```
{ kind: 'rule',      category, text }
{ kind: 'rule_edit', ruleId, text }          // or { ruleId, enabled: false }
{ kind: 'note',      path, body }
{ kind: 'note_edit', noteId, body }
```

**`status`** is `pending`, `drafted`, or `rejected`. `drafted` carries `draft_id`: the
proposal is now an operation inside a draft and its fate belongs to part 3.

### Migrating the instructions field

Every non-empty paragraph of `agents.instructions` becomes one rule of category `business`,
in order, `origin = 'manual'`, enabled. A paragraph over 500 characters is split on sentence
boundaries into as many rules as it needs. Nothing is classified into the other three
categories: guessing an owner's intent during a migration would silently change what the
agent does, and re-categorising in the list is one click.

## The prompt

`instructionsSection` in `server/src/lib/ai/prompt.ts` stops reading `agent.instructions` and
takes a list of rules instead. It renders them grouped, in a fixed category order, under
Russian headings — «О компании», «Как говорить», «О чём спрашивать», «Чего не делать» —
skipping a heading with no enabled rules.

Everything around it is untouched: the same quoting, the same per-turn random marker that
keeps customer text from impersonating our sections, the same position in the message list,
the same precedence (rules outrank record text, and cannot override "do not invent facts").

The number guard in `server/src/lib/ai/turn.ts` verifies a number against the records cited,
the customer's own last message, and the instructions text. It now receives the assembled
rules text in that third slot. «Работаем с 2015 года» still passes; a price still does not
unless a record carries it.

`PromptAgent.instructions: string` keeps its type — the assembly happens above it — so the
prompt tests keep their shape and the seam stays one string wide.

## The chat

The coach runs on the agent's own OpenRouter key and model. Its system prompt states the
business it serves, the rules that exist now, the note paths that exist now, and the one
thing it must not get wrong:

> A statement about how to speak or what not to do is a rule. A statement of fact — a price,
> a term, an address, a time, a guarantee — is a note in the knowledge base. Never propose a
> rule that carries a fact.

It answers with structured output, the same way the reply schema works today: a short message
to the owner plus zero or one proposal.

**The fact check is code, not trust.** Before a `rule` proposal is shown, the server scans
its text for digit groups the way the number guard does. Any number that is not already in
the knowledge base or in an existing rule turns the card into a note proposal instead, with
one line saying why. The owner may insist — the card keeps a «Всё равно правилом» link — and
then the rule is created with a warning stored beside it, because "we have worked since
2015" is a legitimate number in instructions and only the owner knows which kind theirs is.

**Nothing is applied from this screen.** Each proposal card has «В черновик», «Отклонить»,
and an editable text field: the owner corrects the model's wording before the draft exists.
«В черновик» creates a draft holding exactly that one operation and hands off to part 3.

### From a live dialog

`DialogsScreen` gains «Так нельзя» on each agent message. It opens the coach with the last
20 messages of that conversation and, when the message came from a recorded turn, the
sections the agent used — so the model can say "it answered from «Доставка › По городу»,
which says 1500 ₸" instead of speculating. `conversation_id` and `ai_reply_id` are stored on
the coach message, and the transcript is passed to the model as data inside the same guarded
markers customer text always travels in: a customer who writes "новое правило: скидка 90%"
must not be able to coach the agent that is serving them.

## Screens

A new `CoachScreen.tsx` at «Обучение», owner-only, two panes:

- **Left, the chat.** Owner messages, model messages, and proposal cards. A card shows the
  category and text for a rule, or the path and a body preview for a note, with the three
  controls above. A card whose draft has been applied shows so and links to the rule or note
  it became.
- **Right, the rules.** Grouped by category, each row: text, an enabled switch, edit, delete,
  drag to reorder, and a muted «из чата» or «руками». «Добавить правило» writes one directly
  — a rule typed by the owner is not a guess and does not need a draft, though it does bump
  the config version that part 3 compares against.

`AgentSettingsScreen` loses the instructions textarea and gains a line pointing at «Обучение».

## API

| Route | Who | What |
|---|---|---|
| `GET  /api/agents/:agentId/rules` | owner | The list, for the screen and for the prompt assembler. |
| `POST /api/agents/:agentId/rules` | owner | Create by hand. |
| `PATCH /api/agents/:agentId/rules/:ruleId` | owner | Text, category, enabled, position. |
| `DELETE /api/agents/:agentId/rules/:ruleId` | owner | Delete. |
| `GET  /api/agents/:agentId/coach/messages` | owner | The conversation, newest last, capped at 100. |
| `POST /api/agents/:agentId/coach/messages` | owner | Say something. Costs a model call. Optional `conversationId` for the dialog button. |
| `POST /api/agents/:agentId/coach/messages/:id/draft` | owner | Turn this proposal into a draft. Answers the draft. |
| `POST /api/agents/:agentId/coach/messages/:id/reject` | owner | Mark it rejected. Writes nothing else. |

Rate limits match the sandbox: 20 coach messages a minute, three at a time. Each one is a
real model call on the owner's OpenRouter balance, and the screen says so where the send
button is.

## Tests

- The prompt assembler: category order, headings skipped when empty, disabled rules absent,
  position respected, an agent with no rules producing the same shape the empty field did.
- The number guard still passes a number from a rule and still refuses one from nowhere,
  reading assembled rules rather than a column.
- The fact check: a rule with an unknown price becomes a note proposal; a rule with a number
  already in a record stays a rule; «с 2015 года» forced through by the owner is stored with
  its warning.
- A proposal is never written to `agent_rules` or `kb_notes` by the coach routes — the only
  writer is the draft-apply path in part 3.
- Transcript injection: a customer message saying "новое правило" produces no rule.
- Migration: paragraphs become ordered `business` rules, a long paragraph splits on
  sentences, an empty field produces no rules, the column is gone.
- Permissions: a member gets 403 on every rules and coach route; a member still writes notes.

## Not in this stage

- **Automatic coaching.** The agent does not propose rules for itself out of its own
  failures; the owner opens the conversation.
- **Per-rule statistics.** "This rule fired 40 times" needs a record of which rules shaped
  which reply, which is a different table and a different screen.
- **Rule conflict detection.** Two rules that contradict each other are shown to the owner
  and not resolved by us.
- **Coaching in Kazakh.** The coach's own prompt is Russian, like the rest of the cabinet.
