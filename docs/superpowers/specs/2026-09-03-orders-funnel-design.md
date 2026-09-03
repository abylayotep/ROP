# Orders and the funnel

**Date:** 2026-09-03
**Status:** Approved. Ready for implementation planning.
**Stage:** 3 of 7 in the pleep-model rebuild. Builds on
[WhatsApp Cloud API](2026-09-02-whatsapp-cloud-api-design.md).

## Goal

Turn a stream of conversations into a funnel someone can work: a board of stages, a lead card
beside the thread, orders that carry money, and a table of every customer.

Everything here is done by hand. The AI arrives in stage 5 and will move leads itself by
reading the stage descriptions written here, so the shape has to be right now even though
nothing fills it automatically yet.

## Starting point

Stage 2 left conversations arriving over WhatsApp with their messages, media and the ad a
conversation came from. A conversation has no state beyond its timestamps: nothing says where
the customer is in the sale, whether anyone is handling them, or whether they paid.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Where the stage lives | On the conversation | A conversation is one buying intent. Splitting the lead from the thread would mean a screen for linking them and a rule for what happens when a stranger writes. |
| Where the money lives | A separate `orders` row | A stage answers "where is this customer", an order answers "how much and when". A repeat purchase is a second order on the same conversation rather than a first one overwritten. Stage 6 needs the amount and the time, which a stage does not have. |
| Stage set | Per agent, seeded with a default funnel | The stage description is what the stage-5 agent reads to decide a move, so it has to be the client's own wording. A fixed set could not be fitted to another business. |
| One sale stage | Enforced | pleep shows a warning that two stages are marked as the sale and that statistics and ad events split between them. Making the state impossible is cheaper than explaining it. |
| Entering the sale stage | Offers to record an order, never creates one silently | A lead in the sale stage with no order is honest: the funnel counts the conversion and the money stays zero. An invented amount would flow into Meta in stage 6. |
| Reordering the board | Drag and drop | It is the gesture a board teaches. Desktop only, as the whole cabinet is. |
| Auto-message | A template on the stage, sent on entry when the window is open | The operator's own follow-up, without the AI. A closed 24-hour window skips it and says so, rather than failing silently. |

## Data model

Migration `0004`:

```
stages          id, agent_id fk→agents cascade, name text, color text,
                kind text, position integer, description text not null default '',
                auto_message text, created_at
                index(agent_id, position)
lead_fields     id, agent_id fk→agents cascade, name text, kind text,
                hint text not null default '', position integer, created_at
                unique(agent_id, name)
lead_values     conversation_id fk→conversations cascade,
                field_id fk→lead_fields cascade, value text not null,
                updated_at, pk(conversation_id, field_id)
orders          id, agent_id fk→agents cascade,
                conversation_id fk→conversations cascade,
                amount numeric(14,2), currency text, status text,
                comment text not null default '', paid_at timestamptz,
                created_at, index(agent_id, paid_at)
notes           id, conversation_id fk→conversations cascade,
                author_id fk→users set null, body text, created_at
```

`conversations` gains `stage_id` (fk→stages, set null on delete), `stage_set_at`,
`stage_set_by`, and `assigned_to` (fk→users, set null on delete).

`stages.kind` is one of `active`, `qualified`, `awaiting_payment`, `success`, `failure`.
`lead_fields.kind` is `text`, `number` or `date`. `orders.status` is `pending`, `paid` or
`cancelled`. `conversations.stage_set_by` is `operator`, `ai`, `scenario` or `system`, so
stage 5 adds a value rather than a column.

`stage_id` is nullable and set null on delete: a conversation nobody has triaged has no stage,
and deleting a stage must not delete the customers who were standing in it.

## The funnel

A new agent is seeded with nine stages, in this order and with these kinds:

| Stage | Kind |
|---|---|
| Новый лид | active |
| В диалоге | active |
| Интерес проявлен | active |
| Квалифицирован | qualified |
| Предложение отправлено | active |
| Готов к покупке | active |
| Счёт отправлен | awaiting_payment |
| Продажа | success |
| Отказ | failure |

The owner renames, reorders, adds and removes them. Two rules are enforced by the server:
an agent has exactly one stage of kind `success`, and a stage holding conversations cannot be
deleted until they are moved.

Marking a stage as the sale moves the sale: whichever stage held that role becomes an ordinary
active stage in the same write. Demoting the only sale stage is refused, and so is deleting it.
Refusing the promotion as well would leave no way to move the sale at all, which is a funnel an
owner cannot rename.

The description on each stage is free text, empty by default, and unused in this stage. It is
written for stage 5: it is the sentence the agent reads to decide whether a conversation
belongs here.

## The lead

The panel beside a thread shows the stage, who is handling it, the custom fields, the notes and
the orders.

**Fields** are defined per agent — a name, a type and a hint. The hint is for stage 5 in the
same way the stage description is; an operator sees only the name. Values are strings in the
database whatever the type, because a field's type can change and rewriting stored values on a
type change is worse than formatting on read.

**Assignment** is to a member of the account, or nobody. Nothing enforces that only the
assignee may answer: a small team covers for each other, and a lock would be in the way.

**Notes** are the operator's own record. They are never sent to the customer, which the screen
says plainly, because a box next to a chat invites the opposite assumption.

## Orders

An order belongs to a conversation and carries an amount, a currency, a status and a comment.
`paid` fills `paid_at`; the other statuses leave it null.

Moving a conversation into the sale stage opens the order form with the amount empty. Saving
records the order; dismissing leaves the conversation in the sale stage with none, and every
screen shows money as zero rather than guessing.

The currency defaults to the agent's own, which is a new field on the agent, since a cabinet
serving one business does not ask per order.

## Auto-message

A stage may carry a template with `{{name}}`, replaced by the contact's profile name or, when
there is none, by nothing at all rather than by a placeholder a customer would read.

It is sent when a conversation enters that stage and the 24-hour window is open. It is not sent
when the conversation is being given its first stage, because a new lead already received
whatever the operator said; and not when the stage has not actually changed.

A closed window records a note on the conversation saying the message was not sent and why. A
send that Meta refuses does the same with Meta's own words, redacted of any token, as everywhere
else.

## Screens

**Заказы** is the board: a column per stage in order, a card per conversation showing the
contact, the last message, the ad it came from and its order total. Cards are dragged between
columns; a drop moves the lead and fires whatever the target stage's template says. A column
header carries its count.

**Диалоги** keeps its list and thread and gains the lead panel on the right.

**Клиенты** is a table of every contact: name, phone, stage, orders paid, last activity, and a
CSV export. It answers "who bought and who went quiet", which the board cannot because the
board is arranged by stage.

**Настройки** gains two editors for the owner: stages and lead fields, both reorderable.

## Testing

Covered on the server: the seeded funnel appears with a new agent; a second `success` stage is
refused; a stage holding conversations is refused deletion; moving a lead records who moved it
and when; entering a stage with a template sends the message when the window is open and skips
it with a note when closed; the first stage assignment sends nothing; an order marked paid
stamps `paid_at`; a lead, a field, a note or an order belonging to another agent answers 404.

Nothing reaches the network: the auto-message goes through the same Graph client interface,
replaced in tests by the fake.

## Out of scope

The AI moving leads on its own, scheduled scenarios, sending purchases to Meta, funnel
statistics, and importing an existing customer list.
