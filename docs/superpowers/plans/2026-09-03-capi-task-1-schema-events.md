### Task 1: Schema and the event builder

**Files:**
- Modify: `server/src/db/schema.ts`
- Modify: `server/test/helpers/db.ts` (the `truncate` list)
- Create: `server/drizzle/0010_*.sql` (generated)
- Create: `server/src/lib/capi/events.ts`
- Create: `server/test/capi-events.test.ts`

**Interfaces:**
- Produces: the tables `capiSettings` and `capiEvents`; from `server/src/lib/capi/events.ts`:
  - `purchaseEventId(orderId)` and `leadEventId(conversationId)`
  - `buildPurchase(input)` and `buildLead(input)` returning the object Meta is sent
  - `hashPhone(phone)`

**Context.** The store and the pure function that turns a fact into what Meta receives. No routes, no sending.

**The `event_id` is the whole deduplication story.** Meta counts one event per id, so the id must be derived from WHAT is being reported, not from when. A purchase's id comes from the order's id; a lead's from the conversation's. The same order reported twice — by a retry, by a redelivery, by an owner pressing resend — carries the same id and counts once. Prefix each so a purchase and a lead can never collide, and say in a comment that changing this scheme after anything has shipped will make Meta double-count everything reported since.

**Hashing.** Meta wants `user_data` identifiers hashed with SHA-256 over the normalised value. For a phone that means digits only, no plus, no spaces, lowercased — which is already how `contacts.phone` is stored, but normalise anyway rather than trusting a column's promise. Use `node:crypto`.

- [ ] **Step 1: Write the failing test**

Create `server/test/capi-events.test.ts`. It needs no database for the builder — pass it plain objects. Cover:

- a purchase carries `event_name: 'Purchase'`, the order's amount as `value` and its currency, `action_source: 'business_messaging'`, `messaging_channel: 'whatsapp'`, `ctwa_clid` in `user_data`, and the hashed phone;
- `event_time` is the second the order was paid, as a Unix timestamp — not the moment of building. Assert against a paid time a week old and check the number matches that, not now;
- the value is the string from the column, and passes to Meta as a number without going through a float that could round it — decide how and assert the exact value for `1234567.89`;
- a lead carries `event_name: 'Lead'`, no `value` and no `currency`;
- nothing in the built object contains the customer's name, any message text, or the phone in the clear;
- `purchaseEventId` is stable for one order and different for another; `leadEventId` likewise; a purchase's id and a lead's id never collide even for the same underlying row;
- `hashPhone` is SHA-256 hex, lowercase, and gives the same answer for `+7 708 580 79 32` and `77085807932`.

- [ ] **Step 2: Run it and watch it fail**

- [ ] **Step 3: Add the tables**

In `server/src/db/schema.ts`, append after `aiReplies`:

```ts
/**
 * Where an agent's conversions go, and whether they go at all.
 *
 * One row per agent, keyed by the agent: this is the dataset tied to that agent's WhatsApp
 * number, and there is exactly one. pleep also keeps a second dataset for a website pixel;
 * this product has no website channel, and a settings form for a thing nobody can send to
 * is worse than not having it.
 */
export const capiSettings = pgTable('capi_settings', {
  agentId: uuid('agent_id')
    .primaryKey()
    .references(() => agents.id, { onDelete: 'cascade' }),
  datasetId: text('dataset_id').notNull(),
  // Encrypted with the credentials key and sealed to the agent's id, like every other
  // secret here. Never selected into an API response.
  accessToken: text('access_token').notNull(),
  // Meta's test event code. Set while an owner is checking the wiring in Events Manager,
  // cleared afterwards — an event carrying it is not counted for optimisation.
  testEventCode: text('test_event_code'),
  enabled: boolean('enabled').notNull().default(false),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One thing worth telling Meta, and what happened when we told it.
 *
 * `eventId` is unique, and it is derived from what is being reported rather than from when:
 * the same order queued twice by a retry, a redelivery or an owner pressing resend is one
 * row, and Meta counts it once. The payload is stored as built, so a failure can be read
 * afterwards without rebuilding it from rows that may have changed since.
 */
export const capiEvents = pgTable(
  'capi_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    // Set null rather than cascade: a report that has already gone to Meta is a fact about
    // the past, and deleting the conversation does not unmake it.
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    orderId: uuid('order_id').references(() => orders.id, { onDelete: 'set null' }),
    // 'purchase' | 'lead'
    kind: text('kind').notNull(),
    eventId: text('event_id').notNull().unique(),
    payload: jsonb('payload').notNull(),
    // 'pending' | 'sent' | 'failed' | 'skipped'
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    // What Meta answered when it refused. Redacted of the token before it is written.
    error: text('error'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('capi_events_status_created_idx').on(t.status, t.createdAt)],
);
```

- [ ] **Step 4: Extend the truncate list**

Add `capi_events, capi_settings` before `agents`.

- [ ] **Step 5: Generate the migration and read it**

```bash
npm --prefix server run generate
```

Two `CREATE TABLE`, no `DROP`.

- [ ] **Step 6: Write the builder**

Create `server/src/lib/capi/events.ts`. Keep it pure — it takes values, not a `Db`.

- [ ] **Step 7: Run everything and commit**

```bash
npm --prefix server test
npm --prefix server run typecheck
git add server
git commit -m "Store what Meta is told, and build one event"
```
