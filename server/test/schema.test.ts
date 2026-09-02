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
