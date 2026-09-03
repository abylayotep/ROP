### Task 1: Schema — settings, the switch, the reply log

**Files:**
- Modify: `server/src/db/schema.ts`
- Modify: `server/test/helpers/db.ts` (the `truncate` list)
- Create: `server/drizzle/0008_*.sql` (generated)
- Create: `server/test/ai-schema.test.ts`

**Interfaces:**
- Produces: the columns `agents.ai_enabled`, `agents.model`, `agents.temperature`, `agents.instructions`, `agents.reply_language`, `agents.openrouter_key`; `conversations.ai_enabled`; and the table `aiReplies`.

**Context.** Everything the agent needs to be configured and everything a turn leaves behind. No behaviour.

- [ ] **Step 1: Write the failing test**

Create `server/test/ai-schema.test.ts`. Use `server/test/orders-schema.test.ts` as the model — the same `seed` helper shape, direct inserts, no HTTP. Cover:

- a new agent has `aiEnabled` false, a default model, `temperature` `'0.30'`, empty `instructions`, `replyLanguage` `'auto'` and a null `openrouterKey`;
- a new conversation has `aiEnabled` true — the switch is per conversation and defaults to on, because the agent being off for the whole agent is the other switch;
- an `aiReplies` row stores its model, its token counts and its cost, and reading `cost` back gives the string it was written with;
- deleting a conversation deletes its `aiReplies` rows;
- deleting an agent deletes them too.

- [ ] **Step 2: Run it and watch it fail**

```bash
npm --prefix server test -- ai-schema
```

- [ ] **Step 3: Add the columns**

In `server/src/db/schema.ts`, add to the `agents` column block:

```ts
    // The agent answers customers only when this is on. Off is the state a new agent starts
    // in: an owner writes the instructions first and turns it on when the sandbox convinces
    // them, not before.
    aiEnabled: boolean('ai_enabled').notNull().default(false),
    // An OpenRouter model id, exactly as OpenRouter spells it.
    model: text('model').notNull().default('openai/gpt-4o-mini'),
    // numeric, not real: a temperature read back as a string cannot drift through a float,
    // and it is written into a request body as text anyway.
    temperature: numeric('temperature', { precision: 3, scale: 2 }).notNull().default('0.30'),
    // What the owner wrote about how their business sells. The whole of the agent's character.
    instructions: text('instructions').notNull().default(''),
    // 'auto' answers in the language the customer wrote in. Anything else is a language name
    // the instructions will carry verbatim.
    replyLanguage: text('reply_language').notNull().default('auto'),
    // Encrypted with the credentials key, the same way a WhatsApp token is. Never selected
    // into an API response.
    openrouterKey: text('openrouter_key'),
```

Add to the `conversations` column block:

```ts
    // The agent answers on this thread. An operator who steps in turns it off here rather
    // than for the whole agent — the rest of the funnel keeps working.
    aiEnabled: boolean('ai_enabled').notNull().default(true),
```

- [ ] **Step 4: Add the reply log**

Append after `kbItems`:

```ts
/**
 * One turn the model took, whether or not it produced a message.
 *
 * It exists so an owner choosing a model can see what the choice costs, and so a bad answer
 * can be traced to the records it was built from. The reply text is not duplicated here —
 * `messageId` points at the message that was actually sent, and is null when the turn ended
 * in a handoff or a failure.
 */
export const aiReplies = pgTable(
  'ai_replies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),
    model: text('model').notNull(),
    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),
    // What OpenRouter says the turn cost, in US dollars. A string for the same reason an
    // order's amount is one.
    cost: numeric('cost', { precision: 12, scale: 8 }).notNull().default('0'),
    // 'sent' | 'handoff' | 'failed'
    outcome: text('outcome').notNull(),
    // Why it ended that way, when it was not 'sent'. Never carries a key.
    detail: text('detail'),
    // The knowledge records the reply was built from, so a wrong answer leads to the record
    // that produced it.
    usedItemIds: jsonb('used_item_ids').notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ai_replies_agent_created_idx').on(t.agentId, t.createdAt)],
);
```

- [ ] **Step 5: Extend the truncate list**

Add `ai_replies` to the `truncate` in `server/test/helpers/db.ts`, before `messages`.

- [ ] **Step 6: Generate the migration and read it**

```bash
npm --prefix server run generate
```

Read the SQL. It must add seven columns and create one table, with no `DROP`. Existing agents get the defaults, which is right: an agent from stage 4 comes out of this deploy with the AI off, which is the safe state.

- [ ] **Step 7: Run everything**

```bash
npm --prefix server test
npm --prefix server run typecheck
```

- [ ] **Step 8: Commit**

```bash
git add server
git commit -m "Give an agent a model, instructions and a reply log"
```
