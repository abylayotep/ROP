### Task 4: Running a turn

**Files:**
- Create: `server/src/lib/ai/turn.ts`
- Create: `server/test/ai-turn.test.ts`

**Interfaces:**
- Consumes: `ModelClient` and `ModelError` from task 2, `buildMessages` and `REPLY_SCHEMA` from task 3, `searchKnowledge` from stage 4, `sendStageMessage` and `windowOpen` from stage 3, the Graph client, `decryptSecret`.
- Produces:
  - `interface TurnDeps { model: ModelClient; graph: GraphClient; key: Buffer }`
  - `runTurn(db, deps, { agentId, conversationId, dryRun? }): Promise<TurnResult>`
  - `interface TurnResult { outcome: 'sent' | 'handoff' | 'failed' | 'skipped'; reply: string | null; usedItemIds: string[]; stageId: string | null; fields: Record<string,string>; detail: string | null }`

**Context.** One turn, end to end: gather, build, call, validate, apply, send, log. Task 5 calls it from the queue; task 6 calls it with `dryRun` for the sandbox.

**`dryRun` is the sandbox.** It does everything except write: no message is sent, no stage is moved, no field is filled, no note is written, and no `aiReplies` row is inserted. It returns what it would have done. Write it as one flag checked at each write, not as a second code path — a sandbox that runs different code tests different code.

**The refusals, and each is a test.** `runTurn` returns `skipped` without calling the model when:
- the agent's `aiEnabled` is false, or the conversation's is;
- the 24-hour window is closed;
- the agent has no OpenRouter key;
- the last message on the thread is not the customer's — the agent answers customers, not itself, and not an operator who has just written.

**Retrying once.** When the model's answer will not parse, or fails `REPLY_SCHEMA`, call once more with one extra user message saying the answer was not valid JSON and naming the error. If the second answer fails too, the turn is a handoff with a note, not a failure the customer sees. A `ModelError` is not retried — a 401 or a 429 will not come out differently the second time; it is logged as `failed`, the customer is told nothing, and the agent stays on so the next message can try again.

**Applying, and the order matters.** Fields first, then the stage, then the send:
- unknown field ids are dropped silently — the model naming a field that no longer exists must not cost the customer their answer;
- a `stageId` that is not one of this agent's stages is refused and noted in `detail`, and the reply is still sent;
- the stage is moved through the same path an operator's move takes, so `sendStageMessage` still fires and `stageSetBy` records `ai`;
- the reply is sent last, and only if everything before it did not throw. A customer who receives an answer must find the lead in the state that answer implies.

**Handing off** turns off `conversations.aiEnabled`, writes a note with the reason in Russian, and — when the model gave one — still sends its reply, because "I will check with a colleague" is exactly what the customer should read.

- [ ] **Step 1: Write the failing test**

Create `server/test/ai-turn.test.ts`. Build the server fixture the way `server/test/funnel-message.test.ts` does, injecting `fakeModel(...)` and `fakeGraph()`. Cover every refusal above, both retry paths, every applying rule above, `dryRun` writing nothing at all, the `aiReplies` row and its token counts, a `usedItemIds` that names a record from another agent being dropped, and a handoff turning the conversation's switch off and leaving a note.

Two that matter more than the rest:
- a knowledge search that returns nothing produces a handoff, and the reply — if any — never contains a price;
- the API key never appears in any note, any `detail`, or any message, including when the model returns a `ModelError` carrying it.

- [ ] **Step 2: Run it and watch it fail**

- [ ] **Step 3: Write `turn.ts`**

- [ ] **Step 4: Run everything and commit**

```bash
npm --prefix server test
npm --prefix server run typecheck
git add server
git commit -m "Run one agent turn from gather to send"
```
