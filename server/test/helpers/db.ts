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
  await db.execute(
    sql`truncate table sessions, account_members, whatsapp_events, ai_replies, messages, notes, lead_values, lead_fields, orders, conversations, stages, contacts, whatsapp_numbers, kb_items, kb_sources, capi_events, capi_settings, agents, accounts, users restart identity cascade`,
  );
  return db;
}
