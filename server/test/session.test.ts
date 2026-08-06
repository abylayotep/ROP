import { describe, expect, it } from 'vitest';
import { users } from '../src/db/schema.js';
import {
  createSession,
  findValidSession,
  purgeExpiredSessions,
  revokeSession,
  SESSION_TTL_MS,
} from '../src/lib/session.js';
import { withDb } from './helpers/db.js';

const aUser = async (db: Awaited<ReturnType<typeof withDb>>) => {
  const [user] = await db.insert(users).values({
    email: 'u@example.com', passwordHash: 'x', name: 'U', initials: 'UU',
  }).returning();
  return user!;
};

describe('sessions', () => {
  it('finds a session it just created', async () => {
    const db = await withDb();
    const user = await aUser(db);

    const created = await createSession(db, user.id);

    expect((await findValidSession(db, created.id))?.userId).toBe(user.id);
  });

  it('does not find a session past its expiry', async () => {
    const db = await withDb();
    const user = await aUser(db);
    const created = await createSession(db, user.id);

    const afterTtl = new Date(Date.now() + SESSION_TTL_MS + 1000);

    expect(await findValidSession(db, created.id, afterTtl)).toBeNull();
  });

  it('returns null for a malformed id instead of raising', async () => {
    const db = await withDb();

    expect(await findValidSession(db, 'definitely-not-a-uuid')).toBeNull();
  });

  it('returns null for an unknown but well-formed id', async () => {
    const db = await withDb();

    expect(await findValidSession(db, '00000000-0000-4000-8000-000000000000')).toBeNull();
  });

  it('stops finding a revoked session', async () => {
    const db = await withDb();
    const user = await aUser(db);
    const created = await createSession(db, user.id);

    await revokeSession(db, created.id);

    expect(await findValidSession(db, created.id)).toBeNull();
  });

  it('purges expired sessions and keeps live ones', async () => {
    const db = await withDb();
    const user = await aUser(db);
    const live = await createSession(db, user.id);

    await purgeExpiredSessions(db, new Date(Date.now() + SESSION_TTL_MS - 1000));

    expect(await findValidSession(db, live.id)).not.toBeNull();
  });
});
