import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb, type Db } from '../../src/db/client.js';

const URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://rakurs:rakurs@localhost:55432/rakurs_test';

let db: Db | undefined;

/**
 * A migrated, empty database.
 *
 * Migrate once and truncate per test — re-running migrations for every test would
 * dominate the suite's runtime.
 */
export async function withDb(): Promise<Db> {
  if (!db) {
    db = createDb(URL);
    await migrate(db, { migrationsFolder: 'drizzle' });
  }
  await db.execute(sql`truncate table sessions, users, settings restart identity cascade`);
  return db;
}
