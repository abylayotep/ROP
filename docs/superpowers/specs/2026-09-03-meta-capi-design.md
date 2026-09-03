# Meta Conversions API

**Date:** 2026-09-03
**Status:** Approved. Ready for implementation planning.
**Stage:** 6 of 7 in the pleep-model rebuild. Builds on
[the orders funnel](2026-09-03-orders-funnel-design.md) and
[the AI agent](2026-09-03-ai-agent-design.md).

## Goal

Tell Meta which of its ads produced a sale, so it can find more people like the buyer. The
money is already in the cabinet and the click that started the conversation was captured in
stage 2; this stage carries one to the other.

## Why this is worth building

A Click-to-WhatsApp ad ends in a chat, and a chat is invisible to Meta. Without this, the
optimiser learns only that someone opened WhatsApp — so it buys more openers. With it, the
optimiser learns which openers paid, and buys more of those. That is the whole product for a
seller whose customers arrive from Instagram.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Which API | Conversions API for Business Messaging, one dataset tied to the WhatsApp number | It is the only one that accepts `ctwa_clid`, which is the only link between a chat and an ad. |
| The website pixel | Not built | pleep has a second dataset for a website channel. This product has no website channel; a settings page for a thing nobody can send to is worse than nothing. |
| What is sent | `Purchase` when an order is marked paid, `Lead` when a lead first reaches a qualified stage | The money lives on the order, which is why stage 3 put it there. `Lead` is cheap to add and is what the optimiser learns from before anyone pays. |
| Which conversations | Only those carrying `ctwa_clid` | Meta cannot attribute a conversation that did not come from an ad. A lead from a business card is not a failure to report; it is nothing to report. |
| When it is sent | Queued, drained by the pass that already drains WhatsApp events | Marking an order paid must not fail because Meta is down, and an operator must not wait on it. |
| Retries | Five attempts with a widening gap, then it stops and says so | The same cap the WhatsApp queue uses. An event that will never be accepted must stop costing attempts. |
| Duplicates | Every event carries an `event_id` derived from what it reports | Meta deduplicates on it, so a retry, a resend by hand, and a redelivery all count once. |
| Resending by hand | From the lead card, for a conversation that came from an ad | pleep has this and it is the only way to fix a report that failed for a reason the owner has since fixed. |

## Data model

Migration `0010`:

```
capi_settings   agent_id pk fk→agents cascade, dataset_id text,
                access_token text, test_event_code text,
                enabled boolean default false,
                verified_at timestamptz, error text, created_at, updated_at
capi_events     id, agent_id fk→agents cascade,
                conversation_id fk→conversations set null,
                order_id fk→orders set null,
                kind text, event_id text unique,
                payload jsonb, status text, attempts integer default 0,
                error text, sent_at timestamptz, created_at
                index(status, created_at)
```

`capi_events.kind` is `purchase` or `lead`. `status` is `pending`, `sent`, `failed` or
`skipped`. `event_id` is unique so the same fact cannot be queued twice — which is what makes
a resend by hand safe.

The access token is encrypted with the credentials key, sealed to the agent's id, the way
stage 5 seals the OpenRouter key.

## What an event carries

`event_name`, `event_time` — the moment the order was paid, not the moment we send —
`action_source: 'business_messaging'`, `messaging_channel: 'whatsapp'`, and `user_data`
carrying `ctwa_clid` and the WhatsApp phone number hashed with SHA-256. A `Purchase` also
carries `value` and `currency` from the order.

`event_time` matters: Meta attributes against the click, and reporting a week-old sale with
today's timestamp puts it in the wrong window.

Nothing else about the customer is sent. Not their name, not their messages, not what they
asked. Meta needs the click and the amount; it does not need the conversation, and a person
who wrote to a shop did not agree to have it forwarded.

## Failure, and what an owner sees

Every attempt is recorded with what Meta answered. The integrations screen shows the last
events with their status, and a failed one shows Meta's own reason in full — that is where
«Invalid access token» or «ctwa_clid expired» belongs, because the owner is the only person
who can fix either.

Meta's error text can echo the token, exactly as the Graph API does. It is redacted before
it reaches a column, with the function stage 2 wrote for that.

## Testing

Covered on the server: an order marked paid on an ad-sourced conversation queues a purchase;
one on a conversation with no `ctwa_clid` queues nothing; the same order marked paid twice
queues one event; the queue sends and records what Meta answered; a refusal is retried to the
cap and then stops; a token is never in a stored error; a `Lead` is queued once when a lead
first reaches a qualified stage and not again; a resend by hand re-queues with the same
`event_id` so Meta counts it once.

Nothing reaches the network: the Meta client is an interface the tests replace.

## Out of scope

The website pixel, the Marketing API, syncing audiences, reporting anything back from Meta
into the cabinet, and the statistics screen — which is stage 7.
