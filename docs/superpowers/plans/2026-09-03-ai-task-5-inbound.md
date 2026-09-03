### Task 5: Answering a real message

**Files:**
- Modify: `server/src/lib/whatsapp/inbound.ts`
- Modify: `server/src/api/whatsapp-webhook.ts` and `server/src/api/server.ts` (pass the model client through)
- Create: `server/src/api/ai.ts`
- Modify: `packages/contract/index.ts`
- Create: `server/test/ai-inbound.test.ts`

**Interfaces:**
- Produces:
  - `registerAiRoutes(app, db, env, guard, deps)` with:
    - `GET /api/agents/:agentId/ai` → `AiSettings`, any member — never returns the key, only whether one is set
    - `PATCH /api/agents/:agentId/ai` → `AiSettings`, owner
    - `GET /api/ai/models` → `AiModel[]`, any signed-in person
    - `POST /api/agents/:agentId/ai/sandbox` → `AiTurn`, owner
    - `PATCH /api/agents/:agentId/conversations/:conversationId/ai` → `{ aiEnabled: boolean }`, any member
  - `InboundDeps` gains `model: ModelClient` and the turn is run after a stored inbound message.

**Context.** Wiring task 4 into the queue stage 2 built, and giving the cabinet the routes it needs.

**Where the turn runs.** `processPendingEvents` already stores a message and answers Meta before anything slow happens. Run the turn after the message is stored, in the same pass, and let a failure be caught the way the media download's is — a turn that throws must not stop the rest of the delivery, and must not stop the event being marked processed. A customer whose reply failed writes again; an event stuck unprocessed poisons the queue.

**One turn per inbound message, not per event.** A webhook delivery can carry several messages. Run the turn once, after the last one, on each conversation the delivery touched — otherwise a customer who sends three lines gets three answers.

**The key.** `PATCH /ai` accepts `openrouterKey` and stores it encrypted, and accepts `null` to clear it. `GET /ai` returns `keySet: boolean` and never the key. That is the shape `whatsapp-numbers.ts` settled on for the WhatsApp token; follow it.

- [ ] **Step 1: Extend the contract**

`AiSettings` — `aiEnabled`, `model`, `temperature`, `instructions`, `replyLanguage`, `keySet`.
`AiModel` — `id`, `label`, `description`.
`AiTurn` — what the sandbox answers: `reply`, `usedItems` (id and title, so the screen can show which record was used), `stageName`, `fields`, `handoff`, `outcome`, `detail`.

- [ ] **Step 2: Write the failing test**

Create `server/test/ai-inbound.test.ts`. Post a signed webhook the way `server/test/whatsapp-inbound.test.ts` does, with `fakeModel` injected. Cover: an inbound message produces a reply sent through the fake Graph client and stored with `author: 'ai'`; three messages in one delivery produce one reply; the turn not running when the agent is off; a model that throws leaving the event processed and the message stored; the settings routes including that the key is never returned; the sandbox writing nothing; and the per-conversation switch.

- [ ] **Step 3: Write it**

- [ ] **Step 4: Run everything and commit**

```bash
npm --prefix server test
npm --prefix server run typecheck
npm --prefix rakurs run typecheck
git add server packages
git commit -m "Answer a customer when their message arrives"
```
