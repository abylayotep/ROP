# Task 3: The agent guard

Part of [Tenancy and Shell](2026-09-02-tenancy-and-shell.md).

Every route from stage 2 onward lives under `/api/agents/:agentId/…` and needs the same
question answered: may this session touch this agent, and with which powers. One guard, built
once, tested here — so no later route re-invents the check and gets it subtly wrong.

The guard is written and tested against a throwaway route in this task; Task 4 mounts it on
the real ones.

**Files:**
- Create: `server/src/api/require-agent.ts`
- Test: `server/test/require-agent.test.ts`

**Interfaces:**
- Consumes: `requireSession` from `server/src/api/require-session.ts` (it sets `req.user`);
  `accounts`, `accountMembers`, `agents` from Task 1.
- Produces: `requireAgent(db: Db, options?: { role?: 'owner' }): preHandlerHookHandler`, and
  the request augmentation `req.agent: typeof agents.$inferSelect` and
  `req.role: 'owner' | 'member'`.

---

- [ ] **Step 1: Write the failing test**

Create `server/test/require-agent.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { requireAgent } from '../src/api/require-agent.js';
import { requireSession } from '../src/api/require-session.js';
import { buildServer } from '../src/api/server.js';
import { accountMembers, accounts, agents } from '../src/db/schema.js';
import { loadEnv } from '../src/env.js';
import { createAccountWithOwner } from '../src/lib/provision.js';
import { withDb } from './helpers/db.js';

const env = loadEnv({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://x',
  SESSION_SECRET: 'x'.repeat(32),
} as NodeJS.ProcessEnv);

let app: FastifyInstance;
let db: Awaited<ReturnType<typeof withDb>>;
let ownAgentId: string;
let otherAgentId: string;

/** Logs in and returns a cookie jar for app.inject(). */
async function login(email: string, password = 'correct-horse-battery') {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password },
  });
  const cookie = res.cookies[0]!;
  return { [cookie.name]: cookie.value };
}

beforeEach(async () => {
  db = await withDb();
  app = buildServer(env, db);

  // Two routes that exist only for this test: they prove the guard's decision without
  // depending on any real endpoint's behaviour.
  const guard = requireSession(db);
  app.get(
    '/api/agents/:agentId/probe',
    { preHandler: [guard, requireAgent(db)] },
    async (req) => ({ name: req.agent!.name, role: req.role }),
  );
  app.get(
    '/api/agents/:agentId/owner-probe',
    { preHandler: [guard, requireAgent(db, { role: 'owner' })] },
    async () => ({ ok: true }),
  );
  await app.ready();

  const own = await createAccountWithOwner(db, {
    company: 'Сафина',
    email: 'owner@example.com',
    name: 'Владелец',
    initials: 'ВЛ',
    password: 'correct-horse-battery',
  });
  const [ownAgent] = await db
    .insert(agents)
    .values({ accountId: own.accountId, name: 'Сафина' })
    .returning();
  ownAgentId = ownAgent!.id;

  const stranger = await createAccountWithOwner(db, {
    company: 'Чужая',
    email: 'stranger@example.com',
    name: 'Чужой',
    initials: 'ЧУ',
    password: 'correct-horse-battery',
  });
  const [otherAgent] = await db
    .insert(agents)
    .values({ accountId: stranger.accountId, name: 'Чужой агент' })
    .returning();
  otherAgentId = otherAgent!.id;
});

describe('requireAgent', () => {
  it('lets a member of the account through', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/agents/${ownAgentId}/probe`,
      cookies: await login('owner@example.com'),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ name: 'Сафина', role: 'owner' });
  });

  it('hides another account agent behind a 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/agents/${otherAgentId}/probe`,
      cookies: await login('owner@example.com'),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().message).toBe('Агент не найден');
  });

  it('answers 404 for a malformed id instead of raising', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/agents/not-a-uuid/probe',
      cookies: await login('owner@example.com'),
    });

    expect(res.statusCode).toBe(404);
  });

  it('refuses a member on an owner-only route', async () => {
    const [account] = await db.select().from(accounts).where(eq(accounts.name, 'Сафина'));
    await db
      .update(accountMembers)
      .set({ role: 'member' })
      .where(eq(accountMembers.accountId, account!.id));

    const res = await app.inject({
      method: 'GET',
      url: `/api/agents/${ownAgentId}/owner-probe`,
      cookies: await login('owner@example.com'),
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().message).toBe('Недостаточно прав');
  });

  it('still requires a session', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/agents/${ownAgentId}/probe` });

    expect(res.statusCode).toBe(401);
  });
});
```

- [ ] **Step 2: Run the test to see it fail**

```bash
npm --prefix server test -- require-agent
```

Expected: FAIL — cannot resolve `../src/api/require-agent.js`.

- [ ] **Step 3: Write the guard**

Create `server/src/api/require-agent.ts`:

```ts
import { and, eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { Db } from '../db/client.js';
import { accountMembers, agents } from '../db/schema.js';

declare module 'fastify' {
  interface FastifyRequest {
    agent?: typeof agents.$inferSelect;
    role?: 'owner' | 'member';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Membership check for every `/api/agents/:agentId/…` route.
 *
 * A stranger's agent answers 404, not 403: a 403 would confirm the agent exists to
 * someone who has no business knowing that. Only the role check answers 403, and by then
 * the caller has already been shown to belong to the account.
 *
 * Runs after `requireSession`, which is what puts `req.user` in place.
 */
export function requireAgent(
  db: Db,
  options: { role?: 'owner' } = {},
): preHandlerHookHandler {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const { agentId } = req.params as { agentId?: string };

    // The id comes from the URL. Comparing non-UUID text against a uuid column makes
    // Postgres raise, which would turn a typo into a 500.
    if (!agentId || !UUID.test(agentId)) {
      return reply.code(404).send({ message: 'Агент не найден' });
    }

    const [row] = await db
      .select({ agent: agents, role: accountMembers.role })
      .from(agents)
      .innerJoin(accountMembers, eq(accountMembers.accountId, agents.accountId))
      .where(and(eq(agents.id, agentId), eq(accountMembers.userId, req.user!.id)));

    if (!row) return reply.code(404).send({ message: 'Агент не найден' });

    if (options.role === 'owner' && row.role !== 'owner') {
      return reply.code(403).send({ message: 'Недостаточно прав' });
    }

    req.agent = row.agent;
    req.role = row.role === 'owner' ? 'owner' : 'member';
  };
}
```

- [ ] **Step 4: Run the test to see it pass**

```bash
npm --prefix server test -- require-agent
```

Expected: PASS, all five cases.

- [ ] **Step 5: Run the whole suite and typecheck**

```bash
npm --prefix server test
npm --prefix server run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A server
git commit -m "Add the agent membership guard"
```
