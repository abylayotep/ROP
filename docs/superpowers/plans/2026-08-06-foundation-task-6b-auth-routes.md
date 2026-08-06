# Task 6b: Login, logout and /me

Part of [Foundation Implementation Plan](2026-08-06-foundation.md). Global constraints there apply.
Follows [task 6a](2026-08-06-foundation-task-6a-session-guard.md).

**Product strings are Russian here** — the frontend renders `message` straight to the user.

**Files:**
- Create: `server/src/api/auth.ts`, `server/test/auth.test.ts`
- Modify: `server/src/api/server.ts`

**Interfaces:** consumes `verifyPassword`/`hashPassword` (task 4), `createSession`/
`revokeSession`/`SESSION_COOKIE` (task 5), `ApiError` and the guard (task 6a). Produces
`registerAuthRoutes(app, db, env, guard): void`; `POST /api/auth/login` and `GET /api/auth/me`
both return `{ name, initials, email }`.

- [ ] **Step 1: Write the failing test**

`server/test/auth.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { createDb } from '../src/db/client.js';
import { users } from '../src/db/schema.js';
import { loadEnv } from '../src/env.js';
import { hashPassword } from '../src/lib/password.js';
import { SESSION_COOKIE } from '../src/lib/session.js';
import { withDb } from './helpers/db.js';

const env = loadEnv({
  NODE_ENV: 'test', DATABASE_URL: 'postgres://x', SESSION_SECRET: 'x'.repeat(32),
} as NodeJS.ProcessEnv);

let app: ReturnType<typeof buildServer>;

beforeEach(async () => {
  const db = await withDb();
  app = buildServer(env, db);
  await app.ready();
  await db.insert(users).values({
    email: 'owner@example.com',
    passwordHash: await hashPassword('right-password'),
    name: 'Владелец', initials: 'ВЛ',
  });
});

const login = (password: string, email = 'owner@example.com') =>
  app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });

describe('auth', () => {
  it('sets an httpOnly session cookie on success', async () => {
    const res = await login('right-password');

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ name: 'Владелец', initials: 'ВЛ', email: 'owner@example.com' });
    expect(res.cookies[0]).toMatchObject({ name: SESSION_COOKIE, httpOnly: true });
  });

  it('rejects a wrong password', async () => {
    const res = await login('wrong-password');

    expect(res.statusCode).toBe(401);
    expect(res.json().message).toBe('Неверная почта или пароль');
  });

  it('gives an unknown email the same answer as a wrong password', async () => {
    const res = await login('any', 'nobody@example.com');

    expect(res.statusCode).toBe(401);
    expect(res.json().message).toBe('Неверная почта или пароль');
  });

  it('matches the email case-insensitively and ignores surrounding space', async () => {
    expect((await login('right-password', '  OWNER@Example.com ')).statusCode).toBe(200);
  });

  it('rejects a body with no password', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: 'owner@example.com' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('answers /api/auth/me with the cookie from login', async () => {
    const cookie = (await login('right-password')).cookies[0]!;

    const res = await app.inject({
      method: 'GET', url: '/api/auth/me', cookies: { [cookie.name]: cookie.value },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: 'Владелец', initials: 'ВЛ' });
  });

  it('invalidates the session on logout', async () => {
    const cookie = (await login('right-password')).cookies[0]!;
    const jar = { [cookie.name]: cookie.value };

    await app.inject({ method: 'POST', url: '/api/auth/logout', cookies: jar });

    expect((await app.inject({ method: 'GET', url: '/api/auth/me', cookies: jar })).statusCode)
      .toBe(401);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm --prefix server test auth`
Expected: FAIL — every route returns 404, because nothing registers them yet.

- [ ] **Step 3: Implement the routes**

`server/src/api/auth.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { users } from '../db/schema.js';
import type { Env } from '../env.js';
import { ApiError } from '../lib/errors.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { createSession, revokeSession, SESSION_COOKIE } from '../lib/session.js';

const credentials = z.object({ email: z.string().min(1), password: z.string().min(1) });

/**
 * Verified against when the email is unknown, so a missing user costs the same time as a
 * wrong password. Without it, response latency reveals which emails are registered.
 */
const ABSENT_USER_HASH = await hashPassword(randomUUID());

const cookieOptions = (env: Env, expires: Date) => ({
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: env.NODE_ENV === 'production',   // local development is plain http
  path: '/',
  expires,
});

export function registerAuthRoutes(
  app: FastifyInstance, db: Db, env: Env, guard: preHandlerHookHandler,
): void {
  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const parsed = credentials.safeParse(req.body);
      if (!parsed.success) throw new ApiError(400, 'Укажите почту и пароль');

      const email = parsed.data.email.trim().toLowerCase();
      const [user] = await db.select().from(users).where(eq(users.email, email));

      const ok = await verifyPassword(
        user?.passwordHash ?? ABSENT_USER_HASH, parsed.data.password,
      );
      if (!user || !ok) throw new ApiError(401, 'Неверная почта или пароль');

      const session = await createSession(db, user.id);
      reply.setCookie(SESSION_COOKIE, session.id, cookieOptions(env, session.expiresAt));

      // Same shape as /api/auth/me, so the client stores one type either way.
      return { name: user.name, initials: user.initials, email: user.email };
    },
  );

  app.post('/api/auth/logout', async (req, reply) => {
    const id = req.cookies[SESSION_COOKIE];
    if (id) await revokeSession(db, id);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', { preHandler: guard }, async (req) => ({
    name: req.user!.name,
    initials: req.user!.initials,
    email: req.user!.email,
  }));
}
```

- [ ] **Step 4: Register the routes**

In `server/src/api/server.ts`, replace the `void guard;` placeholder line from task 6a with:

```ts
registerAuthRoutes(app, db, env, guard);
```

and add `import { registerAuthRoutes } from './auth.js';` at the top.

- [ ] **Step 5: Run the tests**

```bash
docker compose -f deploy/compose.test.yml up -d
npm --prefix server test
```

Expected: PASS, all suites.

- [ ] **Step 6: Typecheck and commit**

```bash
npm --prefix server run typecheck
git add -A
git commit -m "Add login, logout and /me

Unknown emails are verified against a throwaway hash so response timing
does not reveal which accounts exist, and both failure modes return the
same message."
```
