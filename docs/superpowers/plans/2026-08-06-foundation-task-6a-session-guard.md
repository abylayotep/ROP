# Task 6a: Server plumbing and the session guard

Part of [Foundation Implementation Plan](2026-08-06-foundation.md). Global constraints there apply.

Cookies, rate limiting, the error handler and the guard that protects every route. The login and
logout routes themselves are [task 6b](2026-08-06-foundation-task-6b-auth-routes.md).

**Product strings are Russian here** — the frontend renders `message` straight to the user.

**Files:**
- Create: `server/src/lib/errors.ts`, `server/src/api/require-session.ts`,
  `server/test/require-session.test.ts`
- Modify: `server/src/api/server.ts`, `server/src/index.ts`

**Interfaces:** consumes `Db` (task 3), `findValidSession` and `SESSION_COOKIE` (task 5).
Produces `ApiError`, `requireSession(db: Db): preHandlerHookHandler`, and a widened
`buildServer(env: Env, db: Db): FastifyInstance` — task 2 defined it as `buildServer(env)`.
`request.user` is declared on `FastifyRequest` by module augmentation.

- [ ] **Step 1: Add the error type**

`server/src/lib/errors.ts`:

```ts
export class ApiError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}
```

- [ ] **Step 2: Write the failing test**

`server/test/require-session.test.ts`. The guard is mounted on a throwaway route so it is tested
on its own, before any real route depends on it:

```ts
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { requireSession } from '../src/api/require-session.js';
import { users } from '../src/db/schema.js';
import { createSession, SESSION_COOKIE, SESSION_TTL_MS } from '../src/lib/session.js';
import { withDb } from './helpers/db.js';

async function appWithGuard() {
  const db = await withDb();
  const app = Fastify();
  await app.register(cookie);
  app.get('/protected', { preHandler: requireSession(db) }, async (req) => ({
    initials: req.user!.initials,
  }));
  await app.ready();
  return { app, db };
}

describe('requireSession', () => {
  it('refuses a request with no cookie', async () => {
    const { app } = await appWithGuard();

    expect((await app.inject({ method: 'GET', url: '/protected' })).statusCode).toBe(401);
  });

  it('refuses a junk cookie instead of raising', async () => {
    const { app } = await appWithGuard();

    const res = await app.inject({
      method: 'GET', url: '/protected', cookies: { [SESSION_COOKIE]: 'not-a-uuid' },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().message).toBe('Нужно войти заново');
  });

  it('admits a valid session and exposes the user', async () => {
    const { app, db } = await appWithGuard();
    const [user] = await db.insert(users).values({
      email: 'g@example.com', passwordHash: 'x', name: 'G', initials: 'ГГ',
    }).returning();
    const session = await createSession(db, user!.id);

    const res = await app.inject({
      method: 'GET', url: '/protected', cookies: { [SESSION_COOKIE]: session.id },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ initials: 'ГГ' });
  });

  it('refuses a session that has expired', async () => {
    const { app, db } = await appWithGuard();
    const [user] = await db.insert(users).values({
      email: 'e@example.com', passwordHash: 'x', name: 'E', initials: 'ЕЕ',
    }).returning();
    const session = await createSession(db, user!.id, new Date(Date.now() - SESSION_TTL_MS - 1000));

    const res = await app.inject({
      method: 'GET', url: '/protected', cookies: { [SESSION_COOKIE]: session.id },
    });

    expect(res.statusCode).toBe(401);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npm --prefix server test require-session`
Expected: FAIL — `../src/api/require-session.js` does not exist.

- [ ] **Step 4: Implement the guard**

`server/src/api/require-session.ts`:

```ts
import { eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { Db } from '../db/client.js';
import { users } from '../db/schema.js';
import { findValidSession, SESSION_COOKIE } from '../lib/session.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: typeof users.$inferSelect;
  }
}

export function requireSession(db: Db): preHandlerHookHandler {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const id = req.cookies[SESSION_COOKIE];
    const session = id ? await findValidSession(db, id) : null;
    if (!session) return reply.code(401).send({ message: 'Нужно войти заново' });

    const [user] = await db.select().from(users).where(eq(users.id, session.userId));
    if (!user) return reply.code(401).send({ message: 'Нужно войти заново' });

    req.user = user;
  };
}
```

- [ ] **Step 5: Run the tests**

```bash
docker compose -f deploy/compose.test.yml up -d
npm --prefix server test require-session
```

Expected: PASS, 4 tests.

- [ ] **Step 6: Wire the server**

Rewrite `server/src/api/server.ts`. Unexpected errors are logged in full and answered generically
— a stack trace or a Postgres error inside `{"message"}` would land directly on the user's
screen:

```ts
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Db } from '../db/client.js';
import type { Env } from '../env.js';
import { ApiError } from '../lib/errors.js';
import { requireSession } from './require-session.js';

export function buildServer(env: Env, db: Db): FastifyInstance {
  const app = Fastify({ logger: env.NODE_ENV !== 'test' });

  app.register(cookie, { secret: env.SESSION_SECRET });
  app.register(rateLimit, { global: false });

  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof ApiError) {
      return reply.code(error.statusCode).send({ message: error.message });
    }
    app.log.error(error);
    return reply.code(500).send({ message: 'Внутренняя ошибка сервера' });
  });

  const guard = requireSession(db);

  app.get('/api/health', async () => ({ ok: true }));
  // Task 6b and later plans register their routes here, reusing this one guard.
  void guard;

  return app;
}
```

- [ ] **Step 7: Update the entrypoint**

`server/src/index.ts`:

```ts
import { buildServer } from './api/server.js';
import { createDb } from './db/client.js';
import { loadEnv } from './env.js';

const env = loadEnv();
const db = createDb(env.DATABASE_URL);
const app = buildServer(env, db);

await app.listen({ port: env.PORT, host: '0.0.0.0' });
```

- [ ] **Step 8: Run everything**

`server/test/health.test.ts` still passes one argument to `buildServer` — give it a second,
`buildServer(env, createDb('postgres://unused'))`. The health route never touches the database,
and `createDb` does not connect until a query runs.

```bash
npm --prefix server test && npm --prefix server run typecheck
```

Expected: both pass.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "Add session guard, cookies and the error handler

Unexpected errors are logged and answered generically: the frontend puts
the message field straight on screen, so a stack trace there is a leak."
```
