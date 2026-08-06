# Task 5: Sessions

Part of [Foundation Implementation Plan](2026-08-06-foundation.md). Global constraints there apply.

Session records only. The cookie and the routes are task 6.

**Files:**
- Create: `server/src/lib/session.ts`, `server/test/session.test.ts`

**Interfaces:**
- Consumes: `Db` and the `sessions` table from task 3.
- Produces: `SESSION_COOKIE`, `SESSION_TTL_MS`,
  `createSession(db: Db, userId: string, now?: Date): Promise<Session>`,
  `findValidSession(db: Db, id: string, now?: Date): Promise<Session | null>`,
  `revokeSession(db: Db, id: string): Promise<void>`,
  `purgeExpiredSessions(db: Db, now?: Date): Promise<void>`,
  `type Session = typeof sessions.$inferSelect`

- [ ] **Step 1: Write the failing test**

`server/test/session.test.ts`. `now` is a parameter rather than a call to `Date.now()` inside the
function precisely so expiry can be tested without waiting thirty days or mocking the clock.

The malformed-id case matters: session ids are UUIDs, the cookie is attacker-controlled, and
passing arbitrary text into a `uuid` comparison makes Postgres raise — a 500 on every request
carrying a junk cookie.

```ts
import { describe, expect, it } from 'vitest';
import { users } from '../src/db/schema.js';
import {
  createSession, findValidSession, purgeExpiredSessions, revokeSession, SESSION_TTL_MS,
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
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm --prefix server test session`
Expected: FAIL — cannot resolve `../src/lib/session.js`.

- [ ] **Step 3: Implement**

`server/src/lib/session.ts`:

```ts
import { and, eq, gt, lt } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { sessions } from '../db/schema.js';

export type Session = typeof sessions.$inferSelect;

export const SESSION_COOKIE = 'rakurs_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function createSession(db: Db, userId: string, now = new Date()): Promise<Session> {
  const [row] = await db
    .insert(sessions)
    .values({ userId, expiresAt: new Date(now.getTime() + SESSION_TTL_MS) })
    .returning();
  return row!;
}

export async function findValidSession(
  db: Db, id: string, now = new Date(),
): Promise<Session | null> {
  // The cookie is attacker-controlled. Comparing non-UUID text against a uuid column
  // makes Postgres raise, which would turn a junk cookie into a 500 on every request.
  if (!UUID.test(id)) return null;

  const [row] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, id), gt(sessions.expiresAt, now)));
  return row ?? null;
}

export async function revokeSession(db: Db, id: string): Promise<void> {
  if (!UUID.test(id)) return;
  await db.delete(sessions).where(eq(sessions.id, id));
}

export async function purgeExpiredSessions(db: Db, now = new Date()): Promise<void> {
  await db.delete(sessions).where(lt(sessions.expiresAt, now));
}
```

- [ ] **Step 4: Run the tests**

```bash
docker compose -f deploy/compose.test.yml up -d
npm --prefix server test session
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Run the whole suite and typecheck**

```bash
npm --prefix server test && npm --prefix server run typecheck
```

Expected: both pass.

- [ ] **Step 6: Commit**

```bash
git add server/src/lib/session.ts server/test/session.test.ts
git commit -m "Add session records with expiry and revocation

findValidSession rejects non-UUID ids before querying: the session
cookie is attacker-controlled and a uuid comparison against arbitrary
text raises in Postgres."
```
