# Task 2: Provisioning accounts, owners and members

Part of [Tenancy and Shell](2026-09-02-tenancy-and-shell.md).

There is no sign-up route and there will not be one during the beta. Accounts are created
from a terminal. The logic lives in a library so it can be tested without spawning a process;
the scripts are stdin wrappers around it, following the shape `create-user` already had.

**Files:**
- Create: `server/src/lib/provision.ts`
- Create: `server/src/scripts/create-account.ts`
- Create: `server/src/scripts/add-member.ts`
- Delete: `server/src/scripts/create-user.ts`
- Modify: `server/package.json`
- Test: `server/test/provision.test.ts`

**Interfaces:**
- Consumes: `accounts`, `accountMembers`, `agents`, `users` from Task 1; `hashPassword` from
  `server/src/lib/password.ts`.
- Produces:
  `createAccountWithOwner(db: Db, input: { company: string; email: string; name: string; initials: string; password: string }): Promise<{ accountId: string; userId: string }>`
  and
  `addMember(db: Db, input: { company: string; email: string; name: string; initials: string; password: string; role: 'owner' | 'member' }): Promise<{ accountId: string; userId: string }>`,
  both throwing `ProvisionError` with a Russian message the script prints.

---

- [ ] **Step 1: Write the failing test**

Create `server/test/provision.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to see it fail**

```bash
npm --prefix server test -- provision
```

Expected: FAIL — cannot resolve `../src/lib/provision.js`.

- [ ] **Step 3: Write the provisioning library**

Create `server/src/lib/provision.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to see it pass**

```bash
npm --prefix server test -- provision
```

Expected: PASS, all seven cases.

- [ ] **Step 5: Write the two scripts**

Create `server/src/scripts/create-account.ts`:

```ts
import { createInterface } from 'node:readline/promises';
import { createDb } from '../db/client.js';
import { loadEnv } from '../env.js';
import { createAccountWithOwner, ProvisionError } from '../lib/provision.js';

/**
 * Creates a company and its first user.
 *
 * Reads five lines — company, email, name, initials, password — from prompts on a terminal
 * or from piped stdin. Piped input matters for `docker compose run`; readline's question()
 * never resolves once a pipe has ended, so the two cases cannot share one code path.
 *
 * The password is never taken from argv: arguments land in shell history and are visible in
 * `ps` to every user on the machine.
 */

const FIELDS = ['Company', 'Email', 'Name', 'Initials', 'Password (min 12 chars)'] as const;

async function readAnswers(): Promise<string[]> {
  if (process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answers: string[] = [];
    for (const field of FIELDS) answers.push(await rl.question(`${field}: `));
    rl.close();
    return answers;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').split('\n');
}

const [company = '', email = '', name = '', initials = '', rawPassword = ''] =
  await readAnswers();

const env = loadEnv();
const db = createDb(env.DATABASE_URL);

try {
  await createAccountWithOwner(db, {
    company,
    email,
    name,
    initials,
    password: rawPassword.replace(/\r?\n$/, ''),
  });
  console.log(`Created ${company} with owner ${email.trim().toLowerCase()}.`);
  process.exit(0);
} catch (error) {
  console.error(error instanceof ProvisionError ? error.message : error);
  process.exit(1);
}
```

Create `server/src/scripts/add-member.ts` — the same shape, six fields, and the role validated
before anything touches the database:

```ts
import { createInterface } from 'node:readline/promises';
import { createDb } from '../db/client.js';
import { loadEnv } from '../env.js';
import { addMember, ProvisionError, type Role } from '../lib/provision.js';

/** Adds a person to an existing company. See create-account.ts for why stdin, not argv. */

const FIELDS = [
  'Company',
  'Email',
  'Name',
  'Initials',
  'Password (min 12 chars)',
  'Role (owner|member)',
] as const;

async function readAnswers(): Promise<string[]> {
  if (process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answers: string[] = [];
    for (const field of FIELDS) answers.push(await rl.question(`${field}: `));
    rl.close();
    return answers;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').split('\n');
}

const [company = '', email = '', name = '', initials = '', rawPassword = '', rawRole = ''] =
  await readAnswers();

const role = rawRole.trim().toLowerCase();
if (role !== 'owner' && role !== 'member') {
  console.error('Роль должна быть owner или member');
  process.exit(1);
}

const env = loadEnv();
const db = createDb(env.DATABASE_URL);

try {
  await addMember(db, {
    company,
    email,
    name,
    initials,
    password: rawPassword.replace(/\r?\n$/, ''),
    role: role as Role,
  });
  console.log(`Added ${email.trim().toLowerCase()} to ${company} as ${role}.`);
  process.exit(0);
} catch (error) {
  console.error(error instanceof ProvisionError ? error.message : error);
  process.exit(1);
}
```

- [ ] **Step 6: Swap the npm scripts**

```bash
rm server/src/scripts/create-user.ts
```

In `server/package.json` replace the `create-user` line with:

```json
    "create-account": "tsx src/scripts/create-account.ts",
    "add-member": "tsx src/scripts/add-member.ts",
```

- [ ] **Step 7: Try it against the development database**

```bash
printf 'Сафина\nowner@example.com\nВладелец\nВЛ\ncorrect-horse-battery\n' \
  | DATABASE_URL=postgres://rakurs:rakurs@localhost:55433/rakurs_dev \
    npm --prefix server run create-account
```

Expected: `Created Сафина with owner owner@example.com.` Running it a second time prints
`Пользователь с такой почтой уже есть` and exits 1.

- [ ] **Step 8: Run the whole suite and typecheck**

```bash
npm --prefix server test
npm --prefix server run typecheck
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add -A server
git commit -m "Provision accounts, owners and members from the terminal"
```
