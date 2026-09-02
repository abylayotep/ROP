# Task 4: Agent API and the contract

Part of [Tenancy and Shell](2026-09-02-tenancy-and-shell.md).

The four endpoints the cabinet needs to know who you are and which agents you may open.
The contract gains the four types they return; the prototype-era types stay for now and die
in Task 5, when their last consumer does.

**Files:**
- Modify: `packages/contract/index.ts`
- Create: `server/src/lib/me.ts`
- Create: `server/src/api/agents.ts`
- Modify: `server/src/api/auth.ts`
- Modify: `server/src/api/server.ts`
- Test: `server/test/agents-routes.test.ts`, `server/test/auth.test.ts`

**Interfaces:**
- Consumes: `requireAgent` from Task 3, `createAccountWithOwner` from Task 2, the tables from
  Task 1.
- Produces: contract types
  `Role = 'owner' | 'member'`,
  `Account { id: string; name: string; role: Role }`,
  `Agent { id: string; accountId: string; name: string; description: string; timezone: string }`,
  `Me { name: string; initials: string; email: string; accounts: Account[] }`;
  and `buildMe(db, user): Promise<Me>` from `server/src/lib/me.ts`.

---

- [ ] **Step 1: Add the contract types**

At the top of `packages/contract/index.ts`, above the prototype types, insert:

```ts
/* ── Tenancy ────────────────────────────────────────────────────────────────
 * Account → agents. Everything the cabinet shows belongs to one agent.       */

export type Role = 'owner' | 'member';

/** An account the signed-in person belongs to, with their powers in it. */
export interface Account {
  id: string;
  name: string;
  role: Role;
}

export interface Agent {
  id: string;
  accountId: string;
  name: string;
  description: string;
  timezone: string;
}

/** The signed-in person and where they may go. Returned by login and by /auth/me. */
export interface Me {
  name: string;
  initials: string;
  email: string;
  accounts: Account[];
}
```

- [ ] **Step 2: Write the failing test**

Create `server/test/agents-routes.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { accountMembers } from '../src/db/schema.js';
import { loadEnv } from '../src/env.js';
import { createAccountWithOwner } from '../src/lib/provision.js';
import { withDb } from './helpers/db.js';

const env = loadEnv({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://x',
  SESSION_SECRET: 'x'.repeat(32),
} as NodeJS.ProcessEnv);

const PASSWORD = 'correct-horse-battery';

let app: FastifyInstance;
let db: Awaited<ReturnType<typeof withDb>>;
let accountId: string;
let jar: Record<string, string>;

async function login(email: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: PASSWORD },
  });
  const cookie = res.cookies[0]!;
  return { [cookie.name]: cookie.value };
}

beforeEach(async () => {
  db = await withDb();
  app = buildServer(env, db);
  await app.ready();

  const created = await createAccountWithOwner(db, {
    company: 'Сафина',
    email: 'owner@example.com',
    name: 'Владелец',
    initials: 'ВЛ',
    password: PASSWORD,
  });
  accountId = created.accountId;
  jar = await login('owner@example.com');
});

const createAgent = (payload: unknown, cookies = jar) =>
  app.inject({ method: 'POST', url: `/api/accounts/${accountId}/agents`, cookies, payload });

describe('agent routes', () => {
  it('answers /auth/me with the accounts the person belongs to', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/me', cookies: jar });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      name: 'Владелец',
      initials: 'ВЛ',
      email: 'owner@example.com',
      accounts: [{ id: accountId, name: 'Сафина', role: 'owner' }],
    });
  });

  it('returns the same payload from login', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'owner@example.com', password: PASSWORD },
    });

    expect(res.json().accounts).toEqual([{ id: accountId, name: 'Сафина', role: 'owner' }]);
  });

  it('creates an agent and lists it', async () => {
    const created = await createAgent({ name: 'Сафина', description: 'Светильники' });

    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({
      accountId,
      name: 'Сафина',
      description: 'Светильники',
      timezone: 'Asia/Almaty',
    });

    const list = await app.inject({
      method: 'GET',
      url: `/api/accounts/${accountId}/agents`,
      cookies: jar,
    });
    expect(list.json()).toHaveLength(1);
  });

  it('rejects an agent without a name', async () => {
    const res = await createAgent({ description: 'Без имени' });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('Укажите название агента');
  });

  it('hides another account behind a 404', async () => {
    const stranger = await createAccountWithOwner(db, {
      company: 'Чужая',
      email: 'stranger@example.com',
      name: 'Чужой',
      initials: 'ЧУ',
      password: PASSWORD,
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/accounts/${stranger.accountId}/agents`,
      cookies: jar,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().message).toBe('Компания не найдена');
  });

  it('refuses to let a member create an agent', async () => {
    await db
      .update(accountMembers)
      .set({ role: 'member' })
      .where(eq(accountMembers.accountId, accountId));

    const res = await createAgent({ name: 'Второй' });

    expect(res.statusCode).toBe(403);
    expect(res.json().message).toBe('Недостаточно прав');
  });

  it('reads and renames one agent', async () => {
    const { id } = (await createAgent({ name: 'Сафина' })).json();

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/agents/${id}`,
      cookies: jar,
      payload: { name: 'Сафина 2.0', timezone: 'Europe/Moscow' },
    });
    expect(patched.json()).toMatchObject({ name: 'Сафина 2.0', timezone: 'Europe/Moscow' });

    const read = await app.inject({ method: 'GET', url: `/api/agents/${id}`, cookies: jar });
    expect(read.json().name).toBe('Сафина 2.0');
  });
});
```

- [ ] **Step 3: Run the test to see it fail**

```bash
npm --prefix server test -- agents-routes
```

Expected: FAIL — `/api/auth/me` answers without `accounts`.

- [ ] **Step 4: Build the Me payload**

Create `server/src/lib/me.ts`:

```ts
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
```

- [ ] **Step 5: Make login and /auth/me answer with it**

In `server/src/api/auth.ts`: add `import type { Me } from '@rakurs/contract';` and
`import { buildMe } from '../lib/me.js';`, then replace the two return sites.

The end of the login handler becomes:

```ts
      const session = await createSession(db, user.id);
      reply.setCookie(SESSION_COOKIE, session.id, cookieOptions(env, session.expiresAt));

      // Same shape as /api/auth/me, so the client stores one type either way.
      return buildMe(db, user);
```

and the me route becomes:

```ts
  app.get(
    '/api/auth/me',
    { preHandler: guard },
    async (req): Promise<Me> => buildMe(db, req.user!),
  );
```

- [ ] **Step 6: Write the agent routes**

Create `server/src/api/agents.ts`:

```ts
import type { Agent } from '@rakurs/contract';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { accountMembers, agents } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import { requireAgent } from './require-agent.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const create = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().default(''),
  timezone: z.string().trim().min(1).default('Asia/Almaty'),
});

const patch = z.object({
  name: z.string().trim().min(1).optional(),
  description: z.string().trim().optional(),
  timezone: z.string().trim().min(1).optional(),
});

const toApi = (row: typeof agents.$inferSelect): Agent => ({
  id: row.id,
  accountId: row.accountId,
  name: row.name,
  description: row.description,
  timezone: row.timezone,
});

/**
 * Membership in an account, by the same rule the agent guard uses: a company you do not
 * belong to is answered 404, so the API never confirms that it exists.
 */
async function roleIn(db: Db, accountId: string, userId: string): Promise<string> {
  if (!UUID.test(accountId)) throw new ApiError(404, 'Компания не найдена');

  const [row] = await db
    .select({ role: accountMembers.role })
    .from(accountMembers)
    .where(and(eq(accountMembers.accountId, accountId), eq(accountMembers.userId, userId)));

  if (!row) throw new ApiError(404, 'Компания не найдена');
  return row.role;
}

export function registerAgentRoutes(
  app: FastifyInstance,
  db: Db,
  guard: preHandlerHookHandler,
): void {
  app.get(
    '/api/accounts/:accountId/agents',
    { preHandler: guard },
    async (req): Promise<Agent[]> => {
      const { accountId } = req.params as { accountId: string };
      await roleIn(db, accountId, req.user!.id);

      const rows = await db
        .select()
        .from(agents)
        .where(eq(agents.accountId, accountId))
        .orderBy(agents.name);
      return rows.map(toApi);
    },
  );

  app.post(
    '/api/accounts/:accountId/agents',
    { preHandler: guard },
    async (req): Promise<Agent> => {
      const { accountId } = req.params as { accountId: string };
      if ((await roleIn(db, accountId, req.user!.id)) !== 'owner') {
        throw new ApiError(403, 'Недостаточно прав');
      }

      const parsed = create.safeParse(req.body);
      if (!parsed.success) throw new ApiError(400, 'Укажите название агента');

      const [row] = await db
        .insert(agents)
        .values({ accountId, ...parsed.data })
        .returning();
      return toApi(row!);
    },
  );

  app.get(
    '/api/agents/:agentId',
    { preHandler: [guard, requireAgent(db)] },
    async (req): Promise<Agent> => toApi(req.agent!),
  );

  app.patch(
    '/api/agents/:agentId',
    { preHandler: [guard, requireAgent(db, { role: 'owner' })] },
    async (req): Promise<Agent> => {
      const parsed = patch.safeParse(req.body);
      if (!parsed.success) throw new ApiError(400, 'Не удалось разобрать настройки агента');

      const [row] = await db
        .update(agents)
        .set(parsed.data)
        .where(eq(agents.id, req.agent!.id))
        .returning();
      return toApi(row!);
    },
  );
}
```

- [ ] **Step 7: Register the routes**

In `server/src/api/server.ts` add `import { registerAgentRoutes } from './agents.js';` and,
after the auth line:

```ts
  registerAgentRoutes(app, db, guard);
```

- [ ] **Step 8: Update the auth test**

`server/test/auth.test.ts` asserts login's exact body. The user it seeds has no account, so
`accounts` comes back empty. Change that assertion to:

```ts
    expect(res.json()).toEqual({
      name: 'Владелец',
      initials: 'ВЛ',
      email: 'owner@example.com',
      accounts: [],
    });
```

- [ ] **Step 9: Run the tests**

```bash
npm --prefix server test
npm --prefix server run typecheck
```

Expected: PASS, including the seven agent-route cases.

- [ ] **Step 10: Commit**

```bash
git add -A server packages/contract
git commit -m "Serve accounts and agents over the API"
```
