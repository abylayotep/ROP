# Task 1: Schema, migration, and dropping the settings row

Part of [Tenancy and Shell](2026-09-02-tenancy-and-shell.md).

Adds the three tenancy tables and removes the single-tenant `settings` row together with
everything that reads it. The settings modules must die in this task, not later: dropping the
table while `server/src/lib/settings.ts` still selects from it leaves the tree red.

**Files:**
- Modify: `server/src/db/schema.ts`
- Create: `server/drizzle/0001_*.sql` (generated)
- Modify: `server/test/helpers/db.ts`
- Delete: `server/src/lib/settings.ts`, `server/src/api/settings.ts`, `server/src/api/profile.ts`
- Delete: `server/test/settings-store.test.ts`, `server/test/settings-routes.test.ts`
- Modify: `server/src/api/server.ts`
- Test: `server/test/schema.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: Drizzle tables `accounts`, `accountMembers`, `agents` exported from
  `server/src/db/schema.ts`. Columns:
  `accounts { id: string; name: string; createdAt: Date }`,
  `accountMembers { accountId: string; userId: string; role: string; createdAt: Date }`,
  `agents { id: string; accountId: string; name: string; description: string; timezone: string; createdAt: Date }`.

---

- [ ] **Step 1: Write the failing test**

Create `server/test/schema.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { accountMembers, accounts, agents, users } from '../src/db/schema.js';
import { withDb } from './helpers/db.js';

let db: Awaited<ReturnType<typeof withDb>>;

beforeEach(async () => {
  db = await withDb();
});

const seedAccount = async () => {
  const [account] = await db.insert(accounts).values({ name: 'Сафина' }).returning();
  return account!;
};

const seedUser = async (email: string) =>
  (
    await db
      .insert(users)
      .values({ email, passwordHash: 'x', name: 'Владелец', initials: 'ВЛ' })
      .returning()
  )[0]!;

describe('tenancy schema', () => {
  it('stores an agent under its account', async () => {
    const account = await seedAccount();

    const [agent] = await db
      .insert(agents)
      .values({ accountId: account.id, name: 'Сафина' })
      .returning();

    expect(agent!.description).toBe('');
    expect(agent!.timezone).toBe('Asia/Almaty');
  });

  it('deletes agents and memberships with their account', async () => {
    const account = await seedAccount();
    const user = await seedUser('owner@example.com');
    await db.insert(agents).values({ accountId: account.id, name: 'Сафина' });
    await db
      .insert(accountMembers)
      .values({ accountId: account.id, userId: user.id, role: 'owner' });

    await db.delete(accounts).where(eq(accounts.id, account.id));

    expect(await db.select().from(agents)).toEqual([]);
    expect(await db.select().from(accountMembers)).toEqual([]);
  });

  it('refuses to add the same person to an account twice', async () => {
    const account = await seedAccount();
    const user = await seedUser('owner@example.com');
    const membership = { accountId: account.id, userId: user.id, role: 'owner' };
    await db.insert(accountMembers).values(membership);

    await expect(db.insert(accountMembers).values(membership)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to see it fail**

```bash
npm --prefix server test -- schema
```

Expected: FAIL — `accounts` is not exported from the schema module.

- [ ] **Step 3: Add the tables to the schema**

In `server/src/db/schema.ts`, extend the drizzle import to
`import { boolean, index, numeric, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';`,
delete the whole `settings` table declaration, delete the `role` line from `users`, and append:

```ts
/** A company. Everything else in the product hangs off one of these. */
export const accounts = pgTable('accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Who may see an account, and with which powers. Role lives here rather than on the
 * user: the same person can own one company and answer chats in another.
 */
export const accountMembers = pgTable(
  'account_members',
  {
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // 'owner' | 'member'. Text rather than a Postgres enum: adding a third role later
    // would otherwise need a migration that rewrites the type.
    role: text('role').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.userId] }),
    index('account_members_user_id_idx').on(t.userId),
  ],
);

/**
 * One AI sales rep: its own knowledge, script, funnel and channels. Every table from
 * the next stages carries `agent_id` and reaches the account through this row.
 */
export const agents = pgTable(
  'agents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    timezone: text('timezone').notNull().default('Asia/Almaty'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('agents_account_id_idx').on(t.accountId)],
);
```

The file's header comment still promises a `settings` table. Replace it with:

```ts
/**
 * Tenancy plus authentication. Conversations, orders, knowledge and Meta credentials
 * arrive in their own plans, each with its own migration, and each keyed by agent_id.
 */
```

`boolean` and `numeric` are now unused in the import — drop them from the import list.

- [ ] **Step 4: Delete the settings and profile modules**

```bash
rm server/src/lib/settings.ts server/src/api/settings.ts server/src/api/profile.ts \
   server/test/settings-store.test.ts server/test/settings-routes.test.ts
```

In `server/src/api/server.ts` remove the two imports and the two registration lines, leaving:

```ts
  app.get('/api/health', async () => ({ ok: true }));
  registerAuthRoutes(app, db, env, guard);
  // Later plans register their routes here, reusing the same guard.
```

- [ ] **Step 5: Widen the test helper's truncate**

In `server/test/helpers/db.ts` replace the truncate statement with:

```ts
  await db.execute(
    sql`truncate table sessions, account_members, agents, accounts, users restart identity cascade`,
  );
```

- [ ] **Step 6: Generate the migration**

```bash
npm --prefix server run generate
```

Expected: a new `server/drizzle/0001_*.sql` that creates the three tables, drops `settings`
and drops `users.role`. Read it before continuing — drizzle-kit sometimes asks whether a
change is a rename; answer that `settings` is dropped and `role` is dropped, not renamed.

- [ ] **Step 7: Run the tests**

```bash
docker compose -f deploy/compose.test.yml up -d
npm --prefix server test
npm --prefix server run typecheck
```

Expected: PASS. The suite is smaller now — the settings tests are gone on purpose.

- [ ] **Step 8: Apply the migration to the development database**

```bash
DATABASE_URL=postgres://rakurs:rakurs@localhost:55433/rakurs_dev npm --prefix server run migrate
```

Existing development users survive: only `users.role` is dropped, and nothing read it.

- [ ] **Step 9: Commit**

```bash
git add -A server
git commit -m "Add accounts, memberships and agents; drop the single-tenant settings row"
```
