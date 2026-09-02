import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { accountMembers, accounts, users } from '../db/schema.js';
import { hashPassword } from './password.js';

/** Carries a message meant for whoever is running the script, in their language. */
export class ProvisionError extends Error {}

export type Role = 'owner' | 'member';

/**
 * A database handle or an open transaction. Drizzle gives the transaction callback a
 * different type from the connection, and both provisioning paths need the same insert.
 */
type Executor = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

interface Person {
  email: string;
  name: string;
  initials: string;
  password: string;
}

const MIN_PASSWORD = 12;

function normalise(person: Person) {
  const email = person.email.trim().toLowerCase();
  const name = person.name.trim();
  const initials = person.initials.trim().toUpperCase();

  if (!email.includes('@')) throw new ProvisionError('Почта указана неверно');
  if (!name) throw new ProvisionError('Имя обязательно');
  if (!initials) throw new ProvisionError('Инициалы обязательны');
  if (person.password.length < MIN_PASSWORD) {
    throw new ProvisionError(`Пароль должен быть не короче ${MIN_PASSWORD} символов`);
  }
  return { email, name, initials };
}

async function insertUser(db: Executor, person: Person): Promise<string> {
  const { email, name, initials } = normalise(person);

  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (existing) throw new ProvisionError('Пользователь с такой почтой уже есть');

  const [user] = await db
    .insert(users)
    .values({ email, name, initials, passwordHash: await hashPassword(person.password) })
    .returning({ id: users.id });
  return user!.id;
}

/**
 * Creates a company together with the person who owns it.
 *
 * One transaction on purpose: an account with no members is invisible in the cabinet and
 * can only be cleaned up by hand.
 */
export async function createAccountWithOwner(
  db: Db,
  input: Person & { company: string },
): Promise<{ accountId: string; userId: string }> {
  const company = input.company.trim();
  if (!company) throw new ProvisionError('Название компании обязательно');
  normalise(input); // fail before opening a transaction

  return db.transaction(async (tx) => {
    const [account] = await tx.insert(accounts).values({ name: company }).returning();
    const userId = await insertUser(tx, input);
    await tx.insert(accountMembers).values({ accountId: account!.id, userId, role: 'owner' });
    return { accountId: account!.id, userId };
  });
}

/** Adds a person to a company that already exists, found by its name. */
export async function addMember(
  db: Db,
  input: Person & { company: string; role: Role },
): Promise<{ accountId: string; userId: string }> {
  const company = input.company.trim();
  const matches = await db.select().from(accounts).where(eq(accounts.name, company));

  if (matches.length === 0) throw new ProvisionError('Компания не найдена');
  if (matches.length > 1) {
    throw new ProvisionError('Компаний с таким названием несколько, добавьте участника по id');
  }

  const accountId = matches[0]!.id;
  return db.transaction(async (tx) => {
    const userId = await insertUser(tx, input);
    await tx.insert(accountMembers).values({ accountId, userId, role: input.role });
    return { accountId, userId };
  });
}
