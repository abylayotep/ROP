# Task 2: Server scaffold, environment validation, health endpoint

Part of [Foundation Implementation Plan](2026-08-06-foundation.md). Global constraints there apply.

**Files:**
- Create: `server/package.json`, `server/tsconfig.json`, `server/src/env.ts`,
  `server/src/api/server.ts`, `server/src/index.ts`, `server/test/env.test.ts`

**Interfaces:** produces `loadEnv(source?: NodeJS.ProcessEnv): Env`, `type Env`,
`buildServer(env: Env): FastifyInstance`. Consumes nothing.

- [ ] **Step 1: Scaffold the package**

Install current versions rather than pinning. Only Baileys needs an exact pin, and that arrives
in plan 3.

```bash
mkdir -p server/src/api server/test
cd server && npm init -y
npm install fastify @fastify/cookie @fastify/rate-limit drizzle-orm postgres argon2 zod
npm install -D typescript tsx vitest @types/node drizzle-kit
```

- [ ] **Step 2: Set the package metadata**

Edit `server/package.json` so it has `"type": "module"`, `"private": true`, and these scripts:

```json
{
  "dev": "tsx watch src/index.ts",
  "build": "tsc -p tsconfig.build.json",
  "start": "node dist/index.js",
  "typecheck": "tsc --noEmit",
  "test": "vitest run",
  "migrate": "drizzle-kit migrate",
  "generate": "drizzle-kit generate"
}
```

- [ ] **Step 3: Configure TypeScript**

Two configs. One cannot do both jobs: `rootDir: "src"` and `include: ["src", "test"]` contradict
each other and `tsc` fails with TS6059, but dropping `rootDir` makes the emitted tree `dist/src/`
and breaks `dist/index.js`.

`server/tsconfig.json` — typecheck and editor, covers tests. `noUncheckedIndexedAccess` is on
deliberately: indexed access returns `T | undefined`, which forces the null-handling this
product depends on.

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2023"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "verbatimModuleSyntax": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src", "test"]
}
```

`server/tsconfig.build.json` — emit only, source only:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": false, "rootDir": "src", "outDir": "dist" },
  "include": ["src"]
}
```

- [ ] **Step 4: Write the failing test**

`server/test/env.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/env.js';

const valid = {
  DATABASE_URL: 'postgres://rakurs:rakurs@localhost:5432/rakurs',
  SESSION_SECRET: 'x'.repeat(32),
} as NodeJS.ProcessEnv;

describe('loadEnv', () => {
  it('names the offending variable when one is missing', () => {
    expect(() => loadEnv({ SESSION_SECRET: valid.SESSION_SECRET } as NodeJS.ProcessEnv))
      .toThrow(/DATABASE_URL/);
  });

  it('rejects a session secret shorter than 32 characters', () => {
    expect(() => loadEnv({ ...valid, SESSION_SECRET: 'short' } as NodeJS.ProcessEnv))
      .toThrow(/SESSION_SECRET/);
  });

  it('defaults the port to 3000 and coerces a string port', () => {
    expect(loadEnv(valid).PORT).toBe(3000);
    expect(loadEnv({ ...valid, PORT: '8080' } as NodeJS.ProcessEnv).PORT).toBe(8080);
  });
});
```

- [ ] **Step 5: Run it and watch it fail**

Run: `npm --prefix server test`
Expected: FAIL — cannot resolve `../src/env.js`.

- [ ] **Step 6: Implement the environment loader**

`server/src/env.ts`. Validation is loud and happens once at boot: a server that starts with a
missing variable and fails hours later inside a background job is far harder to diagnose than
one that refuses to start.

```ts
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(32, 'must be at least 32 characters'),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment:\n${problems.join('\n')}`);
  }
  return parsed.data;
}
```

- [ ] **Step 7: Run the tests**

Run: `npm --prefix server test`
Expected: PASS, 3 tests.

- [ ] **Step 8: Add the server builder**

`server/src/api/server.ts`. `buildServer` returns an instance without listening, so tests can
drive it through `app.inject()` with no port and no teardown.

```ts
import Fastify, { type FastifyInstance } from 'fastify';
import type { Env } from '../env.js';

export function buildServer(env: Env): FastifyInstance {
  const app = Fastify({ logger: env.NODE_ENV !== 'test' });

  app.get('/api/health', async () => ({ ok: true }));

  return app;
}
```

- [ ] **Step 9: Add the entrypoint**

`server/src/index.ts`:

```ts
import { buildServer } from './api/server.js';
import { loadEnv } from './env.js';

const env = loadEnv();
const app = buildServer(env);

await app.listen({ port: env.PORT, host: '0.0.0.0' });
```

- [ ] **Step 10: Test the health endpoint**

Create `server/test/health.test.ts`, importing `describe/expect/it` from `vitest`,
`buildServer` from `../src/api/server.js` and `loadEnv` from `../src/env.js`:

```ts
describe('health', () => {
  it('answers without a session', async () => {
    const app = buildServer(loadEnv({
      NODE_ENV: 'test', DATABASE_URL: 'postgres://x', SESSION_SECRET: 'x'.repeat(32),
    } as NodeJS.ProcessEnv));

    const res = await app.inject({ method: 'GET', url: '/api/health' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});
```

- [ ] **Step 11: Run tests and typecheck**

```bash
npm --prefix server test && npm --prefix server run typecheck
```

Expected: both pass.

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "Add server scaffold with validated environment and health endpoint"
```
