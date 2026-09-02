import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { accountMembers, accounts, users } from '../src/db/schema.js';
import { addMember, createAccountWithOwner } from '../src/lib/provision.js';
import { withDb } from './helpers/db.js';

let db: Awaited<ReturnType<typeof withDb>>;

beforeEach(async () => {
  db = await withDb();
});

const owner = {
  company: 'Сафина',
  email: 'Owner@Example.com ',
  name: 'Владелец',
  initials: 'вл',
  password: 'correct-horse-battery',
};

describe('provisioning', () => {
  it('creates the account, the user and an owner membership', async () => {
    const { accountId, userId } = await createAccountWithOwner(db, owner);

    const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId));
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    const [membership] = await db.select().from(accountMembers);

    expect(account!.name).toBe('Сафина');
    expect(user!.email).toBe('owner@example.com');
    expect(user!.initials).toBe('ВЛ');
    expect(user!.passwordHash).not.toContain('correct-horse');
    expect(membership).toMatchObject({ accountId, userId, role: 'owner' });
  });

  it('refuses a password shorter than twelve characters', async () => {
    await expect(createAccountWithOwner(db, { ...owner, password: 'short' })).rejects.toThrow(
      'Пароль должен быть не короче 12 символов',
    );
  });

  it('refuses a second account with the same email', async () => {
    await createAccountWithOwner(db, owner);

    await expect(
      createAccountWithOwner(db, { ...owner, company: 'Вторая' }),
    ).rejects.toThrow('Пользователь с такой почтой уже есть');
  });

  it('leaves nothing behind when the user cannot be created', async () => {
    await createAccountWithOwner(db, owner);

    await createAccountWithOwner(db, { ...owner, company: 'Вторая' }).catch(() => undefined);

    expect(await db.select().from(accounts)).toHaveLength(1);
  });

  it('adds a member to an existing account', async () => {
    const { accountId } = await createAccountWithOwner(db, owner);

    const added = await addMember(db, {
      company: 'Сафина',
      email: 'seller@example.com',
      name: 'Продавец',
      initials: 'ПР',
      password: 'another-long-password',
      role: 'member',
    });

    expect(added.accountId).toBe(accountId);
    expect(await db.select().from(accountMembers)).toHaveLength(2);
  });

  it('attaches a person who already exists to a second account', async () => {
    const first = await createAccountWithOwner(db, owner);
    const [second] = await db.insert(accounts).values({ name: 'Вторая' }).returning();

    const [before] = await db.select().from(users).where(eq(users.email, 'owner@example.com'));

    const added = await addMember(db, {
      company: 'Вторая',
      email: 'owner@example.com',
      // A different name, initials and password: none of them may touch the stored row.
      name: 'Кто-то другой',
      initials: 'КД',
      password: 'x',
      role: 'member',
    });

    expect(added.accountId).toBe(second!.id);
    expect(added.userId).toBe(before!.id);

    const [after] = await db.select().from(users).where(eq(users.email, 'owner@example.com'));
    expect(await db.select().from(users)).toHaveLength(1);
    expect(after!.passwordHash).toBe(before!.passwordHash);
    expect(after!.name).toBe('Владелец');

    const memberships = await db
      .select()
      .from(accountMembers)
      .where(eq(accountMembers.userId, before!.id));
    expect(memberships).toHaveLength(2);
    expect(memberships.map((m) => m.accountId).sort()).toEqual(
      [first.accountId, second!.id].sort(),
    );
  });

  it('refuses to add the same person to the same company twice', async () => {
    await createAccountWithOwner(db, owner);

    await expect(
      addMember(db, {
        company: 'Сафина',
        email: 'owner@example.com',
        name: 'Владелец',
        initials: 'ВЛ',
        password: 'correct-horse-battery',
        role: 'member',
      }),
    ).rejects.toThrow('Этот человек уже в компании');

    expect(await db.select().from(accountMembers)).toHaveLength(1);
  });

  it('refuses to guess when two accounts share a name', async () => {
    await createAccountWithOwner(db, owner);
    await db.insert(accounts).values({ name: 'Сафина' });

    await expect(
      addMember(db, {
        company: 'Сафина',
        email: 'seller@example.com',
        name: 'Продавец',
        initials: 'ПР',
        password: 'another-long-password',
        role: 'member',
      }),
    ).rejects.toThrow('Компаний с таким названием несколько');
  });

  it('reports an unknown company by name', async () => {
    await expect(
      addMember(db, {
        company: 'Нет такой',
        email: 'seller@example.com',
        name: 'Продавец',
        initials: 'ПР',
        password: 'another-long-password',
        role: 'member',
      }),
    ).rejects.toThrow('Компания не найдена');
  });
});
