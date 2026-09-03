### Task 3: Building a turn's prompt

**Files:**
- Create: `server/src/lib/ai/prompt.ts`
- Create: `server/test/ai-prompt.test.ts`

**Interfaces:**
- Consumes: nothing from the database directly — it is given everything.
- Produces:
  - `interface TurnContext { agent; stages; fields; knowledge; history; lead }` — the exact shape is yours to name, but every piece comes from the spec's "What the agent is given".
  - `buildMessages(context: TurnContext): ChatMessage[]`
  - `REPLY_SCHEMA` — the Zod schema for what the model must answer, exported here because the prompt describes it and the two must not drift.

**Context.** A pure function, and the most consequential file in the stage: it is where the agent's honesty is either enforced or lost. Its tests are the specification of what the model is told.

**The rules the system message must state, and the tests must assert are present:**

1. Answer only from the records given below. If they do not cover the question, say you will check and set `handoff`.
2. Never invent a price, a term, an address or a delivery time.
3. Answer in the customer's language unless told otherwise.
4. Reply with one JSON object and nothing else — no prose around it, no code fence.
5. The exact JSON shape, with every field named and what it means.
6. Move the lead only to a stage from the list, and only when its description fits what the customer has said.
7. Fill a field only from what the customer actually said, never from a guess.
8. Keep the reply short — this is WhatsApp, not an email.

Every one of those is a test: given a context, `buildMessages` produces a system message containing that instruction. Assert on a distinctive phrase, not on the whole text, so wording can improve without breaking the suite.

**What else the tests must pin:**

- The knowledge records appear with their ids, so `usedItemIds` can name them, and with their titles and content.
- An empty knowledge list still produces a valid prompt, and the system message says plainly that nothing was found — that is the case where the agent must hand off, and it must be told, not left to infer.
- The stages appear with their ids, names and descriptions; a stage with an empty description still appears, because the agent needs to know it exists.
- The fields appear with their ids, names and hints.
- The history is oldest first, and each message says who sent it — the customer, the operator, or the agent itself.
- The lead's current stage and filled values appear.
- The owner's instructions appear verbatim. They are the business's own words and nothing may paraphrase them.
- The last message in the returned array is the customer's latest message, with role `user`.
- Nothing in the output contains the API key or any part of it — the context does not carry one, and the test proves the type makes that impossible.

**On length.** The history is capped — pass the cap in and default it to something sane like twenty messages. A knowledge record is long; cap the number of records too. Say in a comment that the cap exists so a long conversation cannot outgrow a small model's context, and that the cap is per turn rather than per conversation.

- [ ] **Step 1: Write the failing test**

Create `server/test/ai-prompt.test.ts` covering everything above. It needs no database: build the context by hand. That is the point of the function taking a context rather than a `Db`.

- [ ] **Step 2: Run it and watch it fail**

- [ ] **Step 3: Write `prompt.ts`**

Write the system message as a template built from named sections, not one enormous string literal — a reader has to be able to find the rule they are looking for. Keep the rules in Russian or English as you judge best for the model's comprehension, and say in a comment why you chose: this text is read by a model, not by the owner, so it follows neither the code rule nor the product rule.

`REPLY_SCHEMA` is the Zod schema of the spec's answer shape. `usedItemIds` and `fields` default to empty so a model that omits them does not fail the turn.

- [ ] **Step 4: Run everything and commit**

```bash
npm --prefix server test
npm --prefix server run typecheck
git add server
git commit -m "Build the prompt that tells the agent what it may say"
```
