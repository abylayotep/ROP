# Task 7b: Profile and settings routes

Part of [Foundation Implementation Plan](2026-08-06-foundation.md). Global constraints there apply.
Follows [task 7a](2026-08-06-foundation-task-7a-settings-store.md).

The first endpoints serving real stored data. The typed return values are where the shared
contract package starts earning its keep: a response that drifts from what the frontend expects
stops compiling.

**Files:**
- Create: `server/src/api/profile.ts`, `server/src/api/settings.ts`,
  `server/test/settings-routes.test.ts`
- Modify: `server/src/api/server.ts`

**Interfaces:**
- Consumes: `getSettings`, `updateSettings`, `toApiSettings` (task 7a); `ApiError` and the guard
  (task 6a); `Profile` and `Settings` from `@rakurs/contract`.
- Produces: `registerProfileRoutes(app, db, guard)`, `registerSettingsRoutes(app, db, guard)`.

- [ ] **Step 1: Write the failing test**

`server/test/settings-routes.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { users } from '../src/db/schema.js';
import { loadEnv } from '../src/env.js';
import { hashPassword } from '../src/lib/password.js';
import { withDb } from './helpers/db.js';

const env = loadEnv({
  NODE_ENV: 'test', DATABASE_URL: 'postgres://x', SESSION_SECRET: 'x'.repeat(32),
} as NodeJS.ProcessEnv);

let app: ReturnType<typeof buildServer>;
let jar: Record<string, string>;

beforeEach(async () => {
  const db = await withDb();
  app = buildServer(env, db);
  await app.ready();
  await db.insert(users).values({
    email: 'owner@example.com', passwordHash: await hashPassword('pw'),
    name: 'Владелец', initials: 'ВЛ',
  });
  const res = await app.inject({
    method: 'POST', url: '/api/auth/login',
    payload: { email: 'owner@example.com', password: 'pw' },
  });
  const cookie = res.cookies[0]!;
  jar = { [cookie.name]: cookie.value };
});

describe('profile and settings routes', () => {
  it('refuses the profile without a session', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/profile' })).statusCode).toBe(401);
  });

  it('returns usdRate as a number, not the string Postgres gives back', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/profile', cookies: jar });

    expect(res.statusCode).toBe(200);
    expect(typeof res.json().usdRate).toBe('number');
    expect(res.json().user.initials).toBe('ВЛ');
  });

  it('refuses settings without a session', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/settings' })).statusCode).toBe(401);
  });

  it('persists a settings patch', async () => {
    await app.inject({
      method: 'PATCH', url: '/api/settings', cookies: jar,
      payload: { selectedAccounts: ['act_1', 'act_2'] },
    });

    const res = await app.inject({ method: 'GET', url: '/api/settings', cookies: jar });

    expect(res.json().selectedAccounts).toEqual(['act_1', 'act_2']);
  });

  it('rejects a malformed patch', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/api/settings', cookies: jar,
      payload: { selectedAccounts: 'nope' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('Не удалось разобрать настройки');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm --prefix server test settings-routes`
Expected: FAIL — both routes 404.

- [ ] **Step 3: Implement the profile route**

`server/src/api/profile.ts`. The `Promise<Profile>` annotation is the contract test — the
compiler rejects any field the frontend does not expect, and any it does:

```ts
import type { Profile } from '@rakurs/contract';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { Db } from '../db/client.js';
import { getSettings } from '../lib/settings.js';

export function registerProfileRoutes(
  app: FastifyInstance, db: Db, guard: preHandlerHookHandler,
): void {
  app.get('/api/profile', { preHandler: guard }, async (req): Promise<Profile> => {
    const s = await getSettings(db);
    return {
      projectName: s.projectName,
      planLine: s.planLine,
      currency: s.currency,
      // Plan 2 replaces this with the age of the last Meta sync, which is what the
      // header actually means by "updated". Until then it is the settings row's age.
      updatedMinutesAgo: Math.floor((Date.now() - s.updatedAt.getTime()) / 60_000),
      usdRate: Number(s.usdRate),   // numeric columns come back from Postgres as strings
      user: { initials: req.user!.initials },
    };
  });
}
```

- [ ] **Step 4: Implement the settings routes**

`server/src/api/settings.ts`:

```ts
import type { Settings } from '@rakurs/contract';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { ApiError } from '../lib/errors.js';
import { getSettings, toApiSettings, updateSettings } from '../lib/settings.js';

const patch = z.object({
  selectedAccounts: z.array(z.string()).optional(),
  syncMode: z.string().min(1).optional(),
});

export function registerSettingsRoutes(
  app: FastifyInstance, db: Db, guard: preHandlerHookHandler,
): void {
  app.get('/api/settings', { preHandler: guard }, async (): Promise<Settings> =>
    toApiSettings(await getSettings(db)));

  app.patch('/api/settings', { preHandler: guard }, async (req): Promise<Settings> => {
    const parsed = patch.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, 'Не удалось разобрать настройки');
    return toApiSettings(await updateSettings(db, parsed.data));
  });
}
```

- [ ] **Step 5: Register both**

In `server/src/api/server.ts`, after `registerAuthRoutes(app, db, env, guard);`:

```ts
registerProfileRoutes(app, db, guard);
registerSettingsRoutes(app, db, guard);
```

Add the two imports at the top.

- [ ] **Step 6: Run everything**

```bash
npm --prefix server test && npm --prefix server run typecheck
```

Expected: both pass.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "Serve profile and settings from the database

Return types come from @rakurs/contract, so a response that drifts from
what the frontend expects fails to compile."
```
