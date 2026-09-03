# The AI agent

**Date:** 2026-09-03
**Status:** Approved. Ready for implementation planning.
**Stage:** 5 of 7 in the pleep-model rebuild. Builds on
[the knowledge base](2026-09-03-knowledge-base-design.md).

## Goal

Answer a customer on WhatsApp, in their language, from the knowledge base and nothing else —
and while answering, move the lead along the funnel and fill in what the business asked to
know. Hand the conversation to a person the moment it cannot do that honestly.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Provider | OpenRouter, one model chosen per agent | The owner asked for it, and it is one key for every model. The client is an interface; the tests replace it. |
| How the model answers | One JSON object, validated with Zod | Tool calling is not supported by every model on OpenRouter, and the point of the model picker is that the owner may pick anything. A JSON reply works on all of them, and an invalid one is retried once with the error before the turn is abandoned. |
| What it may say | Only what the knowledge base gave it | A sales assistant that invents a price costs the client a sale and their word. When retrieval returns nothing, the agent says it will check and hands off. |
| When it answers | An inbound message, inside the 24-hour window, when the agent is on and this conversation has not been taken over | Outside the window nothing can be sent anyway. A person who has stepped in owns the conversation until they step out. |
| Where it runs | In the inbound queue, after the message is stored | Meta is already answered by then, so a slow model cannot make Meta retry the webhook. |
| The instructions | Free text the owner writes, plus what the cabinet knows | pleep generates a script with bound stages and branches. That is stage 7's work if it is worth doing; a business that can describe how it sells in a paragraph does not need a diagram first. |
| Cost | Recorded per reply, in tokens and in the model's own price | An owner choosing a model has to be able to see what the choice costs. |

## What the agent is given

Every turn is built fresh from the database — nothing is carried between turns except what is
stored:

- **The instructions** the owner wrote, plus the agent's name and the business's timezone.
- **The funnel**: every stage's name and the description the owner wrote for it, which is what
  stage 3 built that column for.
- **The lead fields**: their names and the hints, which is what stage 3 built those for.
- **The knowledge**: the best matches for the customer's last message, through
  `searchKnowledge`, with their titles — the agent is told to answer from these and to say so
  when they do not cover the question.
- **The conversation**: the last messages, oldest first, with who said each.
- **The lead**: its current stage, and the field values already filled.

## What the agent answers

```
{
  "reply": string,
  "stageId": string | null,
  "fields": { "<fieldId>": string },
  "handoff": { "reason": string } | null,
  "usedItemIds": string[]
}
```

`reply` is what the customer reads. `stageId` moves the lead, and is refused unless it names
one of this agent's stages. `fields` fills what it learned, and unknown ids are dropped rather
than failing the turn. `handoff` stops the agent on this conversation and leaves a note. Both
`stageId` and `fields` are written by the same code paths an operator uses, so the stage move
still fires its auto-message and still records who moved it — `ai` rather than `operator`.

`usedItemIds` is what the reply was built from. It is stored with the message, so an owner
reading a bad answer can see which record produced it and correct that record.

## Handing off

The agent hands off when it says so, and when the cabinet decides for it:

- retrieval returned nothing and the customer asked something factual;
- the model failed twice;
- the reply would be the third in a row with no answer from the customer;
- the customer asked for a person.

A handoff turns the agent off for that conversation, writes a note saying why, and leaves the
last word to a person. Nothing is sent to the customer that the agent did not mean to send.

## The model

`agents` gains `model`, `temperature`, `instructions`, `ai_enabled` and `reply_language`.
`conversations` gains `ai_enabled`, so a person can take one thread without turning the agent
off for everyone.

A reply records the model, the prompt and completion tokens, and the cost OpenRouter reports,
in a table stage 7 will report from.

## The sandbox

The agent screen has a test box: type what a customer would say and see the reply, the records
it used, and what it would have done to the lead — without touching a real conversation and
without sending anything. It is the only way an owner can tune instructions without
experimenting on customers.

## Testing

No test reaches the network: the OpenRouter client is an interface, replaced by a fake that
answers a scripted JSON. Covered: a reply is sent and stored with its sources; a reply is not
sent when the agent is off, when the conversation is taken over, or when the window is closed;
an invalid JSON answer is retried once and then handed off; a `stageId` from another agent is
refused; unknown field ids are dropped; a handoff turns the conversation's agent off and
writes a note; the token usage is recorded.

## Out of scope

Voice, images the agent sends, the improvement chat that proposes instruction diffs, scheduled
follow-ups, a generated sales script with branches, and streaming.
