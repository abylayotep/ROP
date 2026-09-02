import { and, eq, gt, lt } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { sessions } from '../db/schema.js';
import { isUuid } from './uuid.js';

export type Session = typeof sessions.$inferSelect;

export const SESSION_COOKIE = 'rakurs_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** `now` is a parameter so expiry is testable without mocking the clock. */
export async function createSession(db: Db, userId: string, now = new Date()): Promise<Session> {
  const [row] = await db
    .insert(sessions)
    .values({ userId, expiresAt: new Date(now.getTime() + SESSION_TTL_MS) })
    .returning();
  return row!;
}

export async function findValidSession(
  db: Db,
  id: string,
  now = new Date(),
): Promise<Session | null> {
  // The cookie is attacker-controlled. Comparing non-UUID text against a uuid column
  // makes Postgres raise, which would turn a junk cookie into a 500 on every request.
  if (!isUuid(id)) return null;

  const [row] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, id), gt(sessions.expiresAt, now)));
  return row ?? null;
}

export async function revokeSession(db: Db, id: string): Promise<void> {
  if (!isUuid(id)) return;
  await db.delete(sessions).where(eq(sessions.id, id));
}

/** Table hygiene. Expired sessions are already rejected by findValidSession. */
export async function purgeExpiredSessions(db: Db, now = new Date()): Promise<void> {
  await db.delete(sessions).where(lt(sessions.expiresAt, now));
}
