import { eq } from 'drizzle-orm';
import type { Account, Me } from '@rakurs/contract';
import type { Db } from '../db/client.js';
import { accountMembers, accounts, users } from '../db/schema.js';

/**
 * The signed-in person plus every account they may open.
 *
 * Login and /auth/me answer with exactly this, so the client stores one type either way.
 */
export async function buildMe(db: Db, user: typeof users.$inferSelect): Promise<Me> {
  const rows = await db
    .select({ id: accounts.id, name: accounts.name, role: accountMembers.role })
    .from(accountMembers)
    .innerJoin(accounts, eq(accounts.id, accountMembers.accountId))
    .where(eq(accountMembers.userId, user.id))
    .orderBy(accounts.name);

  const list: Account[] = rows.map((row) => ({
    id: row.id,
    name: row.name,
    role: row.role === 'owner' ? 'owner' : 'member',
  }));

  return { name: user.name, initials: user.initials, email: user.email, accounts: list };
}
