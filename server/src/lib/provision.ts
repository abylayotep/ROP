import { and, eq } from 'drizzle-orm';
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

const MIN_PASSWORD = 8;

/** Everything about a person except the password, which not every path needs. */
function normaliseIdentity(person: Omit<Person, 'password'>) {
  const email = person.email.trim().toLowerCase();
  const name = person.name.trim();
  const initials = person.initials.trim().toUpperCase();

  if (!email.includes('@')) throw new ProvisionError('Почта указана неверно');
  if (!name) throw new ProvisionError('Имя обязательно');
  if (!initials) throw new ProvisionError('Инициалы обязательны');
  return { email, name, initials };
}

function normalise(person: Person) {
  const identity = normaliseIdentity(person);
  if (person.password.length < MIN_PASSWORD) {
    throw new ProvisionError(`Пароль должен быть не короче ${MIN_PASSWORD} символов`);
  }
  return identity;
}

async function findUserId(db: Executor, email: string): Promise<string | undefined> {
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  return row?.id;
}

/** Creates the user row. The password rule applies here and only here. */
async function createUser(db: Executor, person: Person): Promise<string> {
  const { email, name, initials } = normalise(person);

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
  const { email } = normalise(input); // fail before opening a transaction

  return db.transaction(async (tx) => {
    const [account] = await tx.insert(accounts).values({ name: company }).returning();

    // A known email is refused rather than reused. Unlike addMember, this path invents a
    // new company's owner, and silently attaching someone else's credentials to it would
    // hand that person an account they never agreed to own.
    if (await findUserId(tx, email)) {
      throw new ProvisionError('Пользователь с такой почтой уже есть');
    }

    const userId = await createUser(tx, input);
    await tx.insert(accountMembers).values({ accountId: account!.id, userId, role: 'owner' });
    return { accountId: account!.id, userId };
  });
}

/**
 * Adds a person to a company that already exists, found by its name.
 *
 * A known email attaches the existing person to this second company instead of failing:
 * the same person can own one company and answer chats in another, and this is the only
 * tool that can put them in both.
 *
 * The password is used only when the person is new. For someone who already exists it is
 * ignored outright — not verified, not re-hashed, not even required to be long. An operator
 * adding a colleague to a second company does not know that colleague's password, and must
 * not be able to set it from here.
 */
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
  const { email } = normaliseIdentity(input);

  return db.transaction(async (tx) => {
    const existingId = await findUserId(tx, email);
    if (existingId) {
      const [membership] = await tx
        .select()
        .from(accountMembers)
        .where(
          and(eq(accountMembers.accountId, accountId), eq(accountMembers.userId, existingId)),
        );
      if (membership) throw new ProvisionError('Этот человек уже в компании');
    }

    const userId = existingId ?? (await createUser(tx, input));
    await tx.insert(accountMembers).values({ accountId, userId, role: input.role });
    return { accountId, userId };
  });
}
