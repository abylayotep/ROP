import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
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
