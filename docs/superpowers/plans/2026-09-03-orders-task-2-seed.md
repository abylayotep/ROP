### Task 2: Seeding the default funnel

**Files:**
- Create: `server/src/lib/funnel.ts`
- Modify: `server/src/api/agents.ts` (the POST route, and the `Agent` mapping)
- Modify: `packages/contract/index.ts` (`Agent` gains `currency`, and the funnel types arrive)
- Create: `server/test/funnel-seed.test.ts`

**Interfaces:**
- Consumes: `stages` and `agents` from `server/src/db/schema.ts`.
- Produces: `DEFAULT_STAGES`, `seedFunnel(db, agentId)` and the type `Executor` from `server/src/lib/funnel.ts`; the contract types `StageKind`, `Stage`, `LeadFieldKind` and `LeadField`.

**Context.** A cabinet whose board is empty on the first day teaches nobody what a stage is. Creating an agent therefore creates its funnel in the same transaction. The set is the client's afterwards: task 3 lets the owner rename, reorder, add and remove.

- [ ] **Step 1: Write the failing test**

Create `server/test/funnel-seed.test.ts`:

```ts
import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { agents, stages } from '../src/db/schema.js';
import { createAccountWithOwner } from '../src/lib/provision.js';
import { DEFAULT_STAGES } from '../src/lib/funnel.js';
import { withDb } from './helpers/db.js';
import { testEnv } from './helpers/env.js';
import { fakeGraph } from './helpers/fake-graph.js';

const env = testEnv();
const PASSWORD = 'correct-horse-battery';

let app: FastifyInstance;
let db: Awaited<ReturnType<typeof withDb>>;
let accountId: string;
let jar: Record<string, string>;

beforeEach(async () => {
  db = await withDb();
  ({ accountId } = await createAccountWithOwner(db, {
    company: 'Сафина',
    email: 'owner@example.com',
    name: 'Владелец',
    initials: 'ВЛ',
    password: PASSWORD,
  }));

  app = buildServer(env, db, { graph: fakeGraph() });
  await app.ready();

  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'owner@example.com', password: PASSWORD },
  });
  const cookie = res.cookies[0]!;
  jar = { [cookie.name]: cookie.value };
});

afterEach(async () => {
  await app.close();
});

describe('the default funnel', () => {
  it('has exactly one sale stage', () => {
    expect(DEFAULT_STAGES.filter((stage) => stage.kind === 'success')).toHaveLength(1);
  });

  it('arrives with a new agent, in order', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/accounts/${accountId}/agents`,
      cookies: jar,
      payload: { name: 'Сафина' },
    });
    expect(res.statusCode).toBe(200);
    const agentId = res.json().id as string;

    const rows = await db
      .select()
      .from(stages)
      .where(eq(stages.agentId, agentId))
      .orderBy(asc(stages.position));

    expect(rows.map((row) => row.name)).toEqual(DEFAULT_STAGES.map((stage) => stage.name));
    expect(rows.map((row) => row.position)).toEqual(DEFAULT_STAGES.map((_, i) => i));
    expect(rows.every((row) => row.description === '')).toBe(true);
    expect(rows.every((row) => row.autoMessage === null)).toBe(true);
  });

  it('reports the currency of the agent it created', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/accounts/${accountId}/agents`,
      cookies: jar,
      payload: { name: 'Вторая' },
    });

    expect(res.json().currency).toBe('KZT');
  });

  it('gives each agent its own funnel', async () => {
    const before = await db.select().from(agents);
    const first = await app.inject({
      method: 'POST',
      url: `/api/accounts/${accountId}/agents`,
      cookies: jar,
      payload: { name: 'Третья' },
    });
    const second = await app.inject({
      method: 'POST',
      url: `/api/accounts/${accountId}/agents`,
      cookies: jar,
      payload: { name: 'Четвёртая' },
    });

    const one = await db.select().from(stages).where(eq(stages.agentId, first.json().id));
    const two = await db.select().from(stages).where(eq(stages.agentId, second.json().id));

    expect(one).toHaveLength(DEFAULT_STAGES.length);
    expect(two).toHaveLength(DEFAULT_STAGES.length);
    expect(await db.select().from(agents)).toHaveLength(before.length + 2);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm --prefix server test -- funnel-seed
```

Expected: the file does not compile — `../src/lib/funnel.js` does not exist.

- [ ] **Step 3: Write the funnel**

Create `server/src/lib/funnel.ts`:

```ts
import type { StageKind } from '@rakurs/contract';
import type { Db } from '../db/client.js';
import { stages } from '../db/schema.js';

/**
 * A database handle or an open transaction.
 *
 * Drizzle gives the transaction callback a different type from the connection, and
 * seeding has to run inside the transaction that creates the agent.
 */
export type Executor = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * The funnel a new agent starts with.
 *
 * Nine stages because that is the shape of a sale someone actually runs: a lead arrives,
 * is talked to, is qualified, is quoted, is invoiced, and then either buys or does not.
 * The owner reshapes it afterwards; this exists so the board is never blank on day one.
 *
 * Exactly one stage has kind `success`. Everything downstream — the statistics of stage 7
 * and the ad events of stage 6 — asks "did this lead reach the sale", and two answers to
 * that question is the confusion this constant refuses to create.
 */
export const DEFAULT_STAGES: { name: string; color: string; kind: StageKind }[] = [
  { name: 'Новый лид', color: '#8a94a6', kind: 'active' },
  { name: 'В диалоге', color: '#4b8ef0', kind: 'active' },
  { name: 'Интерес проявлен', color: '#4b8ef0', kind: 'active' },
  { name: 'Квалифицирован', color: '#7b61ff', kind: 'qualified' },
  { name: 'Предложение отправлено', color: '#e0a13a', kind: 'active' },
  { name: 'Готов к покупке', color: '#e0a13a', kind: 'active' },
  { name: 'Счёт отправлен', color: '#e0a13a', kind: 'awaiting_payment' },
  { name: 'Продажа', color: '#0d9668', kind: 'success' },
  { name: 'Отказ', color: '#d24b4b', kind: 'failure' },
];

/** Writes the default funnel for an agent that has just been created. */
export async function seedFunnel(db: Executor, agentId: string): Promise<void> {
  await db.insert(stages).values(
    DEFAULT_STAGES.map((stage, position) => ({ agentId, position, ...stage })),
  );
}
```

- [ ] **Step 4: Extend the contract**

In `packages/contract/index.ts`, add `currency` to `Agent`:

```ts
export interface Agent {
  id: string;
  accountId: string;
  name: string;
  description: string;
  timezone: string;
  /** ISO 4217. Every order this agent records is in it. */
  currency: string;
}
```

Then append a new section at the end of the file:

```ts
/* ── Воронка ────────────────────────────────────────────────────────────────
 * The funnel an owner shapes, and the fields it asks to be filled. */

export type StageKind = 'active' | 'qualified' | 'awaiting_payment' | 'success' | 'failure';

export interface Stage {
  id: string;
  name: string;
  /** A hex colour, shown as the column's marker. */
  color: string;
  kind: StageKind;
  position: number;
  /** When a lead belongs here, in the owner's own words. Read by the agent in stage 5. */
  description: string;
  /** Sent on entering the stage. Null means the stage sends nothing. */
  autoMessage: string | null;
}

export type LeadFieldKind = 'text' | 'number' | 'date';

export interface LeadField {
  id: string;
  name: string;
  kind: LeadFieldKind;
  /** How to fill it, for the agent in stage 5. Never shown to an operator. */
  hint: string;
  position: number;
}
```

- [ ] **Step 5: Seed from the agent route**

In `server/src/api/agents.ts`, add the imports:

```ts
import { seedFunnel } from '../lib/funnel.js';
```

Add `currency` to `toApi`:

```ts
const toApi = (row: typeof agents.$inferSelect): Agent => ({
  id: row.id,
  accountId: row.accountId,
  name: row.name,
  description: row.description,
  timezone: row.timezone,
  currency: row.currency,
});
```

Replace the body of the POST handler's insert with a transaction:

```ts
      // One transaction: an agent whose funnel failed to write would show an empty board
      // with no way to fill it from the cabinet.
      const row = await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(agents)
          .values({ accountId, ...parsed.data })
          .returning();
        await seedFunnel(tx, created!.id);
        return created!;
      });
      return toApi(row);
```

- [ ] **Step 6: Run the tests**

```bash
npm --prefix server test
npm --prefix server run typecheck
npm --prefix rakurs run typecheck
```

Expected: green. `rakurs` compiles because `Agent` only gained a field and nothing there
constructs one.

- [ ] **Step 7: Commit**

```bash
git add server/src/lib/funnel.ts server/src/api/agents.ts packages/contract/index.ts server/test/funnel-seed.test.ts
git commit -m "Seed a default funnel when an agent is created"
```
