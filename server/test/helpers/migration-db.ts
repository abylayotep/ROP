import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';

/**
 * Drives a scratch database through a prefix of the real migration history, by hand, so a
 * test can stop short of a specific migration and seed the table(s) it is about to consume or
 * transform — something `withDb()` (migrate once, truncate between tests) cannot do, since by
 * the time any test runs, every migration up to the newest has already applied.
 *
 * `tagsBefore` reads `drizzle/meta/_journal.json` for the ordered tag list and `runMigration`
 * applies one migration's `.sql` by splitting it on `--> statement-breakpoint` — exactly what
 * `drizzle-orm`'s own migrator does (see `node_modules/drizzle-orm/migrator.js`). Shared here
 * so each one-way-migration test (`knowledge-vault-migration.test.ts`,
 * `coaching-migration.test.ts`, …) does not carry its own copy of this walk.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DRIZZLE_DIR = path.resolve(HERE, '../../drizzle');

export const ADMIN_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://rakurs:rakurs@localhost:55432/rakurs_test';

type JournalEntry = { idx: number; tag: string };

/** Every migration tag that runs strictly before `targetTag`, in application order. */
export function tagsBefore(targetTag: string): string[] {
  const journal = JSON.parse(
    readFileSync(path.join(DRIZZLE_DIR, 'meta/_journal.json'), 'utf8'),
  ) as { entries: JournalEntry[] };
  const target = journal.entries.find((e) => e.tag === targetTag);
  if (!target) throw new Error(`No journal entry tagged ${targetTag}`);
  return journal.entries.filter((e) => e.idx < target.idx).map((e) => e.tag);
}

/** Applies one migration's `.sql` file, statement by statement, against `sql`. */
export async function runMigration(sql: postgres.Sql, tag: string): Promise<void> {
  const text = readFileSync(path.join(DRIZZLE_DIR, `${tag}.sql`), 'utf8');
  for (const statement of text.split('--> statement-breakpoint')) {
    if (statement.trim().length === 0) continue;
    await sql.unsafe(statement);
  }
}

/** `url` with its path swapped to point at `database` instead. */
export function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}
