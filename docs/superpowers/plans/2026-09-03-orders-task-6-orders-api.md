### Task 6: Orders

**Files:**
- Create: `server/src/api/orders.ts`
- Modify: `server/src/api/server.ts` (register the routes)
- Create: `server/test/orders-api.test.ts`

**Interfaces:**
- Consumes: `requireAgent`, `ApiError`, `isUuid`, `loadLead` from `server/src/api/leads.ts`, the tables `orders` and `conversations`.
- Produces: `registerOrderRoutes(app, db, guard)` and these routes, all open to any member:
  - `POST /api/agents/:agentId/conversations/:conversationId/orders` → `Lead`
  - `PATCH /api/agents/:agentId/orders/:orderId` → `Lead`
  - `DELETE /api/agents/:agentId/orders/:orderId` → `Lead`

**Context.** The money. An order belongs to a conversation, carries an amount in the agent's currency, and is marked paid by hand — the decision made in stage 1, before any payment provider exists.

Every route answers with the whole `Lead`, the way task 4's do, so the panel refreshes its orders, its total and nothing else.

**The amount.** Accepted as a string and validated by a regular expression rather than parsed as a number: `parseFloat` accepts `1e5`, `Infinity` and `0x10`, and each of those would reach the column as something nobody typed. Up to twelve digits before the point and at most two after, matching `numeric(14,2)`.

**Paid.** Setting the status to `paid` stamps `paid_at` if it is not already stamped. Moving away from `paid` clears it. Stage 6 reads that column as the event time, so a cancelled order must not keep one.

- [ ] **Step 1: Write the failing test**

Create `server/test/orders-api.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { agents, contacts, conversations, orders, whatsappNumbers } from '../src/db/schema.js';
import { addMember, createAccountWithOwner } from '../src/lib/provision.js';
import { withDb } from './helpers/db.js';
import { testEnv } from './helpers/env.js';
import { fakeGraph } from './helpers/fake-graph.js';

const env = testEnv();
const PASSWORD = 'correct-horse-battery';

let app: FastifyInstance;
let db: Awaited<ReturnType<typeof withDb>>;
let accountId: string;
let agentId: string;
let conversationId: string;
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

const ordersUrl = () => `/api/agents/${agentId}/conversations/${conversationId}/orders`;

/** Records an order and returns its id. */
async function record(payload: Record<string, unknown>) {
  const res = await app.inject({ method: 'POST', url: ordersUrl(), cookies: jar, payload });
  return { res, id: res.json().orders?.at(-1)?.id as string };
}

beforeEach(async () => {
  db = await withDb();
  ({ accountId } = await createAccountWithOwner(db, {
    company: 'Сафина',
    email: 'owner@example.com',
    name: 'Владелец',
    initials: 'ВЛ',
    password: PASSWORD,
  }));
  await addMember(db, {
    company: 'Сафина',
    email: 'member@example.com',
    name: 'Оператор',
    initials: 'ОП',
    password: PASSWORD,
    role: 'member',
  });

  app = buildServer(env, db, { graph: fakeGraph() });
  await app.ready();
  jar = await login('owner@example.com');

  const created = await app.inject({
    method: 'POST',
    url: `/api/accounts/${accountId}/agents`,
    cookies: jar,
    payload: { name: 'Сафина' },
  });
  agentId = created.json().id;

  const [number] = await db
    .insert(whatsappNumbers)
    .values({
      agentId,
      phoneNumberId: '136',
      wabaId: 'waba',
      displayPhone: '+7 708 580 79 32',
      accessToken: 'x',
    })
    .returning();
  const [contact] = await db
    .insert(contacts)
    .values({ agentId, phone: '77085807932', name: 'Айгуль' })
    .returning();
  const [conversation] = await db
    .insert(conversations)
    .values({ agentId, contactId: contact!.id, whatsappNumberId: number!.id })
    .returning();
  conversationId = conversation!.id;
});

afterEach(async () => {
  await app.close();
});

describe('recording an order', () => {
  it('starts pending, in the currency of its agent, and counts nothing yet', async () => {
    const { res } = await record({ amount: '450000' });

    expect(res.statusCode).toBe(200);
    const order = res.json().orders[0];
    expect(order.amount).toBe('450000.00');
    expect(order.currency).toBe('KZT');
    expect(order.status).toBe('pending');
    expect(order.paidAt).toBeNull();
    expect(res.json().paidTotal).toBe('0.00');
  });

  it('records a comment', async () => {
    const { res } = await record({ amount: '1000', comment: 'Две двери, монтаж в среду' });

    expect(res.json().orders[0].comment).toBe('Две двери, монтаж в среду');
  });

  it('can be paid from the start', async () => {
    const { res } = await record({ amount: '450000.50', status: 'paid' });

    expect(res.json().orders[0].paidAt).not.toBeNull();
    expect(res.json().paidTotal).toBe('450000.50');
  });

  it('keeps a second purchase as a second order', async () => {
    await record({ amount: '100000', status: 'paid' });
    const { res } = await record({ amount: '50000', status: 'paid' });

    expect(res.json().orders).toHaveLength(2);
    expect(res.json().paidTotal).toBe('150000.00');
  });

  it('refuses an amount that is not a plain number', async () => {
    for (const amount of ['1e5', 'Infinity', '0x10', '-100', '1.234', '', 'сто тысяч']) {
      const res = await app.inject({
        method: 'POST',
        url: ordersUrl(),
        cookies: jar,
        payload: { amount },
      });
      expect(res.statusCode, amount).toBe(400);
    }
  });

  it('refuses an amount too large for the column', async () => {
    const res = await app.inject({
      method: 'POST',
      url: ordersUrl(),
      cookies: jar,
      payload: { amount: '1234567890123' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('accepts zero, which is how a gift is recorded', async () => {
    const { res } = await record({ amount: '0', status: 'paid' });

    expect(res.json().orders[0].amount).toBe('0.00');
  });
});

describe('changing an order', () => {
  it('stamps the payment time when it is marked paid', async () => {
    const { id } = await record({ amount: '450000' });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/agents/${agentId}/orders/${id}`,
      cookies: jar,
      payload: { status: 'paid' },
    });

    expect(res.json().orders[0].paidAt).not.toBeNull();
    expect(res.json().paidTotal).toBe('450000.00');
  });

  it('keeps the original payment time when something else changes', async () => {
    const { id } = await record({ amount: '450000', status: 'paid' });
    const first = (
      await app.inject({
        url: `/api/agents/${agentId}/conversations/${conversationId}/lead`,
        cookies: jar,
      })
    ).json().orders[0].paidAt;

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/agents/${agentId}/orders/${id}`,
      cookies: jar,
      payload: { comment: 'Оплата картой' },
    });

    expect(res.json().orders[0].paidAt).toBe(first);
  });

  it('clears the payment time when it is cancelled', async () => {
    const { id } = await record({ amount: '450000', status: 'paid' });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/agents/${agentId}/orders/${id}`,
      cookies: jar,
      payload: { status: 'cancelled' },
    });

    expect(res.json().orders[0].paidAt).toBeNull();
    expect(res.json().paidTotal).toBe('0.00');
  });

  it('refuses a status nobody defined', async () => {
    const { id } = await record({ amount: '450000' });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/agents/${agentId}/orders/${id}`,
      cookies: jar,
      payload: { status: 'refunded' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('deletes an order', async () => {
    const { id } = await record({ amount: '450000', status: 'paid' });

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/agents/${agentId}/orders/${id}`,
      cookies: jar,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().orders).toEqual([]);
    expect(await db.select().from(orders)).toHaveLength(0);
  });
});

describe('access', () => {
  it('lets a member record an order', async () => {
    const memberJar = await login('member@example.com');

    const res = await app.inject({
      method: 'POST',
      url: ordersUrl(),
      cookies: memberJar,
      payload: { amount: '1000' },
    });

    expect(res.statusCode).toBe(200);
  });

  it("answers 404 for another agent's order", async () => {
    const { id } = await record({ amount: '450000' });
    const [other] = await db.insert(agents).values({ accountId, name: 'Другая' }).returning();

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/agents/${other!.id}/orders/${id}`,
      cookies: jar,
      payload: { status: 'paid' },
    });

    expect(res.statusCode).toBe(404);
  });

  it('answers 404 for an order id that is not a uuid', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/agents/${agentId}/orders/не-uuid`,
      cookies: jar,
    });

    expect(res.statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm --prefix server test -- orders-api
```

Expected: every case fails with 404 — no route is registered yet.

- [ ] **Step 3: Write the routes**

Create `server/src/api/orders.ts`:

```ts
import type { Lead } from '@rakurs/contract';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { orders } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import { isUuid } from '../lib/uuid.js';
import { loadLead } from './leads.js';
import { requireAgent } from './require-agent.js';

const STATUSES = ['pending', 'paid', 'cancelled'] as const;

/**
 * Up to twelve digits before the point and at most two after — the shape of
 * `numeric(14,2)`.
 *
 * Matched rather than parsed on purpose: `parseFloat` happily accepts `1e5`, `Infinity`
 * and `0x10`, and every one of those would reach the column as an amount nobody typed.
 */
const AMOUNT = /^\d{1,12}(\.\d{1,2})?$/;

const amount = z.string().trim().regex(AMOUNT);

const createOrder = z.object({
  amount,
  status: z.enum(STATUSES).default('pending'),
  comment: z.string().trim().default(''),
});

const patchOrder = z.object({
  amount: amount.optional(),
  status: z.enum(STATUSES).optional(),
  comment: z.string().trim().optional(),
});

export function registerOrderRoutes(
  app: FastifyInstance,
  db: Db,
  guard: preHandlerHookHandler,
): void {
  // Any member: recording what a customer paid is the job, not an administrative act.
  const anyMember = requireAgent(db);

  const lead = async (agentId: string, conversationId: string, currency: string): Promise<Lead> => ({
    ...(await loadLead(db, agentId, conversationId)),
    currency,
  });

  /** The agent's order, or a 404 that tells a stranger nothing. */
  async function loadOrder(agentId: string, orderId: string) {
    if (!isUuid(orderId)) throw new ApiError(404, 'Заказ не найден');
    const [row] = await db
      .select()
      .from(orders)
      .where(and(eq(orders.id, orderId), eq(orders.agentId, agentId)));
    if (!row) throw new ApiError(404, 'Заказ не найден');
    return row;
  }

  app.post(
    '/api/agents/:agentId/conversations/:conversationId/orders',
    { preHandler: [guard, anyMember] },
    async (req): Promise<Lead> => {
      const { conversationId } = req.params as { conversationId: string };
      const parsed = createOrder.safeParse(req.body);
      if (!parsed.success) {
        throw new ApiError(400, 'Укажите сумму: только цифры, максимум две после точки');
      }

      // Proves the conversation belongs to this agent before anything is written.
      await loadLead(db, req.agent!.id, conversationId);

      await db.insert(orders).values({
        agentId: req.agent!.id,
        conversationId,
        amount: parsed.data.amount,
        // Taken from the agent, never from the request: one business, one currency, and a
        // per-order choice would make every total a question about which rows it summed.
        currency: req.agent!.currency,
        status: parsed.data.status,
        comment: parsed.data.comment,
        paidAt: parsed.data.status === 'paid' ? new Date() : null,
      });
      return lead(req.agent!.id, conversationId, req.agent!.currency);
    },
  );

  app.patch(
    '/api/agents/:agentId/orders/:orderId',
    { preHandler: [guard, anyMember] },
    async (req): Promise<Lead> => {
      const { orderId } = req.params as { orderId: string };
      const current = await loadOrder(req.agent!.id, orderId);

      const parsed = patchOrder.safeParse(req.body);
      if (!parsed.success) throw new ApiError(400, 'Не удалось разобрать заказ');

      if (Object.keys(parsed.data).length > 0) {
        const patch: Partial<typeof orders.$inferInsert> = { ...parsed.data };

        if (parsed.data.status !== undefined && parsed.data.status !== current.status) {
          // Stage 6 reports `paidAt` as the moment of the purchase, so a cancelled order
          // must not keep one, and a payment already stamped must not be restamped by an
          // edit to the comment.
          patch.paidAt = parsed.data.status === 'paid' ? (current.paidAt ?? new Date()) : null;
        }

        await db.update(orders).set(patch).where(eq(orders.id, current.id));
      }
      return lead(req.agent!.id, current.conversationId, req.agent!.currency);
    },
  );

  app.delete(
    '/api/agents/:agentId/orders/:orderId',
    { preHandler: [guard, anyMember] },
    async (req): Promise<Lead> => {
      const { orderId } = req.params as { orderId: string };
      const current = await loadOrder(req.agent!.id, orderId);

      await db.delete(orders).where(eq(orders.id, current.id));
      return lead(req.agent!.id, current.conversationId, req.agent!.currency);
    },
  );
}
```

- [ ] **Step 4: Register the routes**

In `server/src/api/server.ts`:

```ts
import { registerOrderRoutes } from './orders.js';
```

```ts
  registerOrderRoutes(app, db, guard);
```

- [ ] **Step 5: Run the tests**

```bash
npm --prefix server test
npm --prefix server run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add server/src/api/orders.ts server/src/api/server.ts server/test/orders-api.test.ts
git commit -m "Record orders against a conversation"
```
