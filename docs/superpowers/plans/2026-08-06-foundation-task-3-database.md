# Task 3: Database schema, migrations, test Postgres

Part of [Foundation Implementation Plan](2026-08-06-foundation.md). Global constraints there apply.

Only the three tables this plan needs. Advertising, WhatsApp, analysis and money tables arrive
in their own plans, each with its own migration.

**Files:**
- Create: `server/src/db/schema.ts`, `server/src/db/client.ts`, `server/drizzle.config.ts`,
  `deploy/compose.test.yml`, `server/test/helpers/db.ts`, `server/test/db.test.ts`

**Interfaces:** produces tables `users`, `sessions`, `settings`; `createDb(url: string): Db`;
`type Db = ReturnType<typeof createDb>`; test helper `withDb(): Promise<Db>`.

- [ ] **Step 1: Write the schema**

`server/src/db/schema.ts`. Email is stored lowercased and compared as plain text rather than
using `citext`, which would mean installing an extension for one column.

```ts
import { boolean, index, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),          // always stored lowercased
  passwordHash: text('password_hash').notNull(),
  name: text('name').notNull(),
  initials: text('initials').notNull(),
  role: text('role').notNull().default('owner'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('sessions_expires_at_idx').on(t.expiresAt)]);

/** Single row, pinned by a boolean primary key that defaults to true. */
export const settings = pgTable('settings', {
  id: boolean('id').primaryKey().default(true),
  projectName: text('project_name').notNull(),
  planLine: text('plan_line').notNull(),
  currency: text('currency').notNull(),
  usdRate: numeric('usd_rate', { precision: 12, scale: 4 }).notNull(),
  timezone: text('timezone').notNull(),
  selectedAccountIds: text('selected_account_ids').array().notNull().default([]),
  syncMode: text('sync_mode').notNull(),
  metaBusinessId: text('meta_business_id'),
  metaPixelId: text('meta_pixel_id'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 2: Add the client**

`server/src/db/client.ts`:

```ts
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export function createDb(url: string) {
  return drizzle(postgres(url), { schema });
}

export type Db = ReturnType<typeof createDb>;
```

- [ ] **Step 3: Add the Drizzle config**

`server/drizzle.config.ts`:

```ts
import type { Config } from 'drizzle-kit';

export default {
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
} satisfies Config;
```

- [ ] **Step 4: Generate the migration**

```bash
npm --prefix server run generate
```

- [ ] **Step 5: Read the generated SQL**

Open the file in `server/drizzle/`. It must create exactly three tables, one foreign key with
`on delete cascade`, one unique constraint on `users.email`, and one index on
`sessions.expires_at` — nothing else. These run in production; reading them is not optional.

- [ ] **Step 6: Add a test database**

`deploy/compose.test.yml`, on a non-default port so it cannot collide with a real Postgres.
`tmpfs` keeps data in memory, so a restarted container starts empty and nothing leaks between
runs:

```yaml
services:
  postgres-test:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: rakurs
      POSTGRES_PASSWORD: rakurs
      POSTGRES_DB: rakurs_test
    ports: ['55432:5432']
    tmpfs: [/var/lib/postgresql/data]
```

- [ ] **Step 7: Write the test helper**

`server/test/helpers/db.ts`. Migrate once, truncate per test — re-running migrations for every
test would dominate the suite's runtime.

```ts
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { sql } from 'drizzle-orm';
import { createDb, type Db } from '../../src/db/client.js';

const URL = process.env.TEST_DATABASE_URL
  ?? 'postgres://rakurs:rakurs@localhost:55432/rakurs_test';

let db: Db | undefined;

export async function withDb(): Promise<Db> {
  if (!db) {
    db = createDb(URL);
    await migrate(db, { migrationsFolder: 'drizzle' });
  }
  await db.execute(sql`truncate table sessions, users, settings restart identity cascade`);
  return db;
}
```

- [ ] **Step 7b: Stop test files running in parallel**

`server/vitest.config.ts`. Without this the suite is flaky in a way that reads as a foreign key
bug: Vitest runs files in parallel, every file calls `withDb()`, and one file's `truncate`
deletes another file's fixtures mid-test.

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { fileParallelism: false },
});
```

- [ ] **Step 8: Write the failing test**

`server/test/db.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { sessions, users } from '../src/db/schema.js';
import { withDb } from './helpers/db.js';

describe('schema', () => {
  it('stores and reads a user', async () => {
    const db = await withDb();
    await db.insert(users).values({
      email: 'owner@example.com', passwordHash: 'x', name: 'Owner', initials: 'OW',
    });

    const [row] = await db.select().from(users).where(eq(users.email, 'owner@example.com'));

    expect(row?.initials).toBe('OW');
  });

  it('rejects a duplicate email', async () => {
    const db = await withDb();
    const value = { email: 'dup@example.com', passwordHash: 'x', name: 'A', initials: 'AA' };
    await db.insert(users).values(value);

    await expect(db.insert(users).values(value)).rejects.toThrow();
  });

  it('deletes sessions with their user', async () => {
    const db = await withDb();
    const [user] = await db.insert(users).values({
      email: 'cascade@example.com', passwordHash: 'x', name: 'C', initials: 'CC',
    }).returning();

    await db.insert(sessions).values({
      userId: user!.id, expiresAt: new Date(Date.now() + 60_000),
    });
    await db.delete(users).where(eq(users.id, user!.id));

    expect(await db.select().from(sessions)).toHaveLength(0);
  });
});
```

- [ ] **Step 9: Start the database and run the tests**

```bash
docker compose -f deploy/compose.test.yml up -d
npm --prefix server test
```

Expected: PASS. A connection failure on the very first run means the container is still
starting — wait a few seconds and rerun.

If the image cannot be pulled at all (`dial tcp … i/o timeout` against `registry-1.docker.io`),
Docker Hub is unreachable from this network. Point the daemon at a mirror rather than switching
to a locally installed Postgres, because the deploy in task 9b needs image pulls too:

```bash
colima ssh -- sudo sh -c 'printf "{\"registry-mirrors\":[\"https://mirror.gcr.io\"]}\n" > /etc/docker/daemon.json'
colima restart
```

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "Add database schema, migrations and a containerised test database"
```
