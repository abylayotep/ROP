### Task 1: Schema and migration

**Files:**
- Modify: `server/src/db/schema.ts` (append after `messages`, before `whatsappEvents`)
- Modify: `server/test/helpers/db.ts` (the `truncate` list)
- Create: `server/drizzle/0004_*.sql` (generated, do not hand-write)
- Create: `server/test/orders-schema.test.ts`

**Interfaces:**
- Consumes: `agents`, `conversations`, `users` from `server/src/db/schema.ts`.
- Produces: the tables `stages`, `leadFields`, `leadValues`, `orders`, `notes`; the columns `conversations.stageId`, `conversations.stageSetAt`, `conversations.stageSetBy`, `conversations.assignedTo`; the column `agents.currency`.

**Context.** Stage 2 left `conversations` carrying only timestamps and the ad it came from. Nothing says where the customer is in the sale, who is handling them, or whether they paid. This task adds those columns and the tables the rest of the plan writes to. It adds no route and no behaviour.

- [ ] **Step 1: Write the failing test**

Create `server/test/orders-schema.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  accounts,
  agents,
  contacts,
  conversations,
  leadFields,
  leadValues,
  notes,
  orders,
  stages,
  whatsappNumbers,
} from '../src/db/schema.js';
import { withDb } from './helpers/db.js';

/** An agent with one conversation on it — the fixture every case here starts from. */
async function seed(db: Awaited<ReturnType<typeof withDb>>) {
  const [account] = await db.insert(accounts).values({ name: 'Сафина' }).returning();
  const [agent] = await db
    .insert(agents)
    .values({ accountId: account!.id, name: 'Сафина' })
    .returning();
  const [number] = await db
    .insert(whatsappNumbers)
    .values({
      agentId: agent!.id,
      phoneNumberId: `pn-${Math.random().toString(36).slice(2)}`,
      wabaId: 'waba',
      displayPhone: '+7 708 580 79 32',
      accessToken: 'x',
    })
    .returning();
  const [contact] = await db
    .insert(contacts)
    .values({ agentId: agent!.id, phone: '77085807932' })
    .returning();
  const [conversation] = await db
    .insert(conversations)
    .values({
      agentId: agent!.id,
      contactId: contact!.id,
      whatsappNumberId: number!.id,
    })
    .returning();

  return { agentId: agent!.id, conversationId: conversation!.id };
}

describe('orders schema', () => {
  it('defaults an agent to tenge', async () => {
    const db = await withDb();
    const { agentId } = await seed(db);

    const [row] = await db.select().from(agents).where(eq(agents.id, agentId));

    expect(row?.currency).toBe('KZT');
  });

  it('stores a stage with its kind, position and template', async () => {
    const db = await withDb();
    const { agentId } = await seed(db);

    const [stage] = await db
      .insert(stages)
      .values({
        agentId,
        name: 'Продажа',
        color: '#0d9668',
        kind: 'success',
        position: 8,
        autoMessage: 'Спасибо за покупку, {{name}}!',
      })
      .returning();

    expect(stage?.description).toBe('');
    expect(stage?.autoMessage).toBe('Спасибо за покупку, {{name}}!');
  });

  it('keeps a conversation when its stage is deleted', async () => {
    const db = await withDb();
    const { agentId, conversationId } = await seed(db);
    const [stage] = await db
      .insert(stages)
      .values({ agentId, name: 'Новый лид', color: '#8a94a6', kind: 'active', position: 0 })
      .returning();
    await db
      .update(conversations)
      .set({ stageId: stage!.id, stageSetAt: new Date(), stageSetBy: 'operator' })
      .where(eq(conversations.id, conversationId));

    await db.delete(stages).where(eq(stages.id, stage!.id));

    const [row] = await db.select().from(conversations).where(eq(conversations.id, conversationId));
    expect(row).toBeDefined();
    expect(row?.stageId).toBeNull();
  });

  it('refuses two lead fields with one name on one agent', async () => {
    const db = await withDb();
    const { agentId } = await seed(db);
    const value = { agentId, name: 'Город', kind: 'text', position: 0 };
    await db.insert(leadFields).values(value);

    await expect(db.insert(leadFields).values(value)).rejects.toThrow();
  });

  it('holds one value per field per conversation', async () => {
    const db = await withDb();
    const { agentId, conversationId } = await seed(db);
    const [leadField] = await db
      .insert(leadFields)
      .values({ agentId, name: 'Город', kind: 'text', position: 0 })
      .returning();

    await db
      .insert(leadValues)
      .values({ conversationId, fieldId: leadField!.id, value: 'Алматы' });
    await db
      .insert(leadValues)
      .values({ conversationId, fieldId: leadField!.id, value: 'Астана' })
      .onConflictDoUpdate({
        target: [leadValues.conversationId, leadValues.fieldId],
        set: { value: 'Астана' },
      });

    const rows = await db.select().from(leadValues);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toBe('Астана');
  });

  it('keeps an amount exact to the tiyn', async () => {
    const db = await withDb();
    const { agentId, conversationId } = await seed(db);

    const [order] = await db
      .insert(orders)
      .values({ agentId, conversationId, amount: '1234567.89', currency: 'KZT' })
      .returning();

    // numeric arrives as a string on purpose: a float would round this.
    expect(order?.amount).toBe('1234567.89');
    expect(order?.status).toBe('pending');
    expect(order?.paidAt).toBeNull();
  });

  it('deletes notes and orders with their conversation', async () => {
    const db = await withDb();
    const { agentId, conversationId } = await seed(db);
    await db.insert(notes).values({ conversationId, body: 'Просил перезвонить в среду' });
    await db.insert(orders).values({ agentId, conversationId, amount: '1000', currency: 'KZT' });

    await db.delete(conversations).where(eq(conversations.id, conversationId));

    expect(await db.select().from(notes)).toHaveLength(0);
    expect(await db.select().from(orders)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm --prefix server test -- orders-schema
```

Expected: the file does not compile — `stages`, `leadFields`, `leadValues`, `orders` and `notes` are not exported from the schema.

- [ ] **Step 3: Add the columns to the tables that already exist**

In `server/src/db/schema.ts`, add to the `agents` column block, after `timezone`:

```ts
    // ISO 4217. One business, one currency: an order form that asks every time would
    // be asking a question the answer to which never changes.
    currency: text('currency').notNull().default('KZT'),
```

Add to the `conversations` column block, after `referralSeenAt`:

```ts
    // Nullable and `set null` on delete: a conversation nobody has triaged has no stage,
    // and removing a stage must not remove the customers who were standing in it.
    stageId: uuid('stage_id').references((): AnyPgColumn => stages.id, { onDelete: 'set null' }),
    stageSetAt: timestamp('stage_set_at', { withTimezone: true }),
    // 'operator' | 'ai' | 'scenario' | 'system'. Stage 5 adds a value, not a column.
    stageSetBy: text('stage_set_by'),
    assignedTo: uuid('assigned_to').references(() => users.id, { onDelete: 'set null' }),
```

`stages` is declared below `conversations`, so its reference needs the lazy form with an
explicit return type. Add `AnyPgColumn` to the type import at the top of the file:

```ts
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
```

- [ ] **Step 4: Add the five tables**

Append to `server/src/db/schema.ts`, after `messages` and before `whatsappEvents`:

```ts
/**
 * One column of the funnel.
 *
 * `description` is written for stage 5: it is the sentence the agent will read to decide
 * whether a conversation belongs here. Nothing in this stage reads it, and it is empty by
 * default rather than absent, so the editor never has to reason about null.
 *
 * Exactly one stage per agent may have kind `success`. That is a rule the API enforces
 * rather than a constraint here: a partial unique index would make the seeding order
 * matter and would fail an owner's reorder mid-transaction with a message nobody can read.
 */
export const stages = pgTable(
  'stages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color').notNull(),
    // 'active' | 'qualified' | 'awaiting_payment' | 'success' | 'failure'
    kind: text('kind').notNull(),
    position: integer('position').notNull(),
    description: text('description').notNull().default(''),
    // Sent when a lead enters this stage. Null means the stage sends nothing.
    autoMessage: text('auto_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('stages_agent_position_idx').on(t.agentId, t.position)],
);

/**
 * A field the business wants filled on every lead.
 *
 * `hint` is stage 5's instruction for filling it, the same way `stages.description` is.
 * An operator sees only the name.
 */
export const leadFields = pgTable(
  'lead_fields',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    // 'text' | 'number' | 'date'
    kind: text('kind').notNull(),
    hint: text('hint').notNull().default(''),
    position: integer('position').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('lead_fields_agent_name_key').on(t.agentId, t.name)],
);

/**
 * What one lead answered for one field.
 *
 * Always text, whatever the field's kind: a field's type can be changed after values
 * exist, and rewriting stored answers on a type change loses more than formatting on
 * read ever costs.
 */
export const leadValues = pgTable(
  'lead_values',
  {
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    fieldId: uuid('field_id')
      .notNull()
      .references(() => leadFields.id, { onDelete: 'cascade' }),
    value: text('value').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.conversationId, t.fieldId] })],
);

/**
 * Money.
 *
 * Separate from the stage on purpose: a stage says where the customer is, an order says
 * how much and when. A second purchase from the same person is a second row here rather
 * than a first one overwritten, and stage 6 reports the row, because only the row knows
 * the amount and the time.
 */
export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    // Read back as a string. A float cannot hold 1234567.89 and money must not round.
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    currency: text('currency').notNull(),
    // 'pending' | 'paid' | 'cancelled'
    status: text('status').notNull().default('pending'),
    comment: text('comment').notNull().default(''),
    // Filled only by 'paid'. Stage 6 sends this as the event time.
    paidAt: timestamp('paid_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('orders_conversation_idx').on(t.conversationId),
    index('orders_agent_paid_at_idx').on(t.agentId, t.paidAt),
  ],
);

/**
 * The operator's own record on a lead, and the only place the cabinet writes to when it
 * cannot do what it was asked — an auto-message it could not send leaves its reason here.
 *
 * Never sent to the customer. `authorId` is null for the cabinet's own lines.
 */
export const notes = pgTable(
  'notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('notes_conversation_created_idx').on(t.conversationId, t.createdAt)],
);
```

- [ ] **Step 5: Extend the truncate list**

In `server/test/helpers/db.ts`, replace the `truncate` statement with:

```ts
  await db.execute(
    sql`truncate table sessions, account_members, whatsapp_events, messages, notes, lead_values, lead_fields, orders, conversations, stages, contacts, whatsapp_numbers, agents, accounts, users restart identity cascade`,
  );
```

- [ ] **Step 6: Generate the migration**

```bash
npm --prefix server run generate
```

Read the generated `server/drizzle/0004_*.sql` before continuing. It must create five
tables and alter two, and it must contain no `DROP TABLE` and no `DROP COLUMN`. If it
does, the schema edit was wrong — fix the schema and regenerate rather than editing the
SQL, which would leave `server/drizzle/meta` disagreeing with it.

- [ ] **Step 7: Run the tests**

```bash
npm --prefix server test
npm --prefix server run typecheck
```

Expected: the new file passes and the twenty existing files still pass. The migration is
applied by `withDb()` on the first test that asks for a database.

- [ ] **Step 8: Commit**

```bash
git add server/src/db/schema.ts server/drizzle server/test/helpers/db.ts server/test/orders-schema.test.ts
git commit -m "Add stages, lead fields, orders and notes to the schema"
```
