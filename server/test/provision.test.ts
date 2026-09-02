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
