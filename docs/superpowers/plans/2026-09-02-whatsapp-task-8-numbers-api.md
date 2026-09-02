# Task 8: Connecting a number

Part of [WhatsApp Cloud API](2026-09-02-whatsapp-cloud-api.md).

The owner pastes three values and the server proves they work. Two things must happen and both
matter: the token is checked against Meta, and our application is subscribed to the client's
WABA. A number saved without that subscription looks connected in the cabinet and stays silent
forever, which is the single most confusing way this integration can fail.

**Files:**
- Create: `server/src/api/whatsapp-numbers.ts`
- Modify: `server/src/api/server.ts`, `packages/contract/index.ts`
- Test: `server/test/whatsapp-numbers.test.ts`

**Interfaces:**
- Consumes: `requireAgent` from stage 1; `GraphClient` from task 3; `encryptSecret` from task 1.
- Produces: contract type
  `WhatsappNumber { id: string; phoneNumberId: string; wabaId: string; displayPhone: string; enabled: boolean; subscribed: boolean; connectedAt: string }`
  and `WebhookSetup { url: string; verifyToken: string }`;
  routes `GET|POST /api/agents/:agentId/whatsapp/numbers`,
  `PATCH|DELETE /api/agents/:agentId/whatsapp/numbers/:numberId`,
  `GET /api/agents/:agentId/whatsapp/setup`.

---

- [ ] **Step 1: Add the contract types**

In `packages/contract/index.ts`, below the tenancy block:

```ts
/* ── WhatsApp ───────────────────────────────────────────────────────────────
 * A connected number, and what the owner must paste into Meta to connect one. */

export interface WhatsappNumber {
  id: string;
  phoneNumberId: string;
  wabaId: string;
  /** As Meta formats it, for a human to recognise. */
  displayPhone: string;
  enabled: boolean;
  /** False means Meta accepted the number but will not deliver anything yet. */
  subscribed: boolean;
  connectedAt: string;
}

/** What to paste into the Meta application's webhook settings. */
export interface WebhookSetup {
  url: string;
  verifyToken: string;
}
```

The access token is deliberately absent: it goes in, it never comes out.

- [ ] **Step 2: Write the failing test**

Create `server/test/whatsapp-numbers.test.ts` with the contents given in
[task 8, step 2](2026-09-02-whatsapp-task-8-numbers-test.md) — fifteen cases covering the
connection, the encrypted token, both Meta failures, a number already taken, the role check,
listing, switching off, disconnecting, and what to paste into Meta. Copy it verbatim.

- [ ] **Step 3: Run it and watch it fail**

```bash
npm --prefix server test -- whatsapp-numbers
```

Expected: FAIL — `buildServer` takes two arguments today.

- [ ] **Step 4: Let the server be given a Graph client**

In `server/src/api/server.ts`, add a third parameter so tests can inject a fake, defaulting to
the real one so nothing else changes:

```ts
export interface ServerDeps {
  graph?: GraphClient;
}

export function buildServer(env: Env, db: Db, deps: ServerDeps = {}): FastifyInstance {
  const graph = deps.graph ?? createGraphClient();
```

Use that `graph` for both the webhook dependencies and the new routes.

- [ ] **Step 5: Write the routes**

Create `server/src/api/whatsapp-numbers.ts`:

```ts
import type { WebhookSetup, WhatsappNumber } from '@rakurs/contract';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { whatsappNumbers } from '../db/schema.js';
import type { Env } from '../env.js';
import { ApiError } from '../lib/errors.js';
import { credentialsKey, encryptSecret } from '../lib/secret-box.js';
import { GraphError, type GraphClient } from '../lib/whatsapp/graph.js';
import { requireAgent } from './require-agent.js';

const connection = z.object({
  phoneNumberId: z.string().trim().min(1),
  wabaId: z.string().trim().min(1),
  accessToken: z.string().trim().min(1),
});

const enabling = z.object({ enabled: z.boolean() });

/** The access token is never part of this. It goes in and it does not come out. */
const toApi = (row: typeof whatsappNumbers.$inferSelect): WhatsappNumber => ({
  id: row.id,
  phoneNumberId: row.phoneNumberId,
  wabaId: row.wabaId,
  displayPhone: row.displayPhone,
  enabled: row.enabled,
  subscribed: row.subscribedAt !== null,
  connectedAt: row.createdAt.toISOString(),
});

/** Postgres reports a unique violation with this code; Drizzle passes it through. */
const isDuplicate = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505';

export function registerWhatsappNumberRoutes(
  app: FastifyInstance,
  db: Db,
  env: Env,
  guard: preHandlerHookHandler,
  graph: GraphClient,
): void {
  const anyMember = requireAgent(db);
  const ownerOnly = requireAgent(db, { role: 'owner' });

  app.get(
    '/api/agents/:agentId/whatsapp/numbers',
    { preHandler: [guard, anyMember] },
    async (req): Promise<WhatsappNumber[]> => {
      const rows = await db
        .select()
        .from(whatsappNumbers)
        .where(eq(whatsappNumbers.agentId, req.agent!.id))
        .orderBy(whatsappNumbers.createdAt);
      return rows.map(toApi);
    },
  );

  app.post(
    '/api/agents/:agentId/whatsapp/numbers',
    { preHandler: [guard, ownerOnly] },
    async (req): Promise<WhatsappNumber> => {
      const parsed = connection.safeParse(req.body);
      if (!parsed.success) throw new ApiError(400, 'Заполните все три поля');
      const { phoneNumberId, wabaId, accessToken } = parsed.data;

      // Prove the token before storing anything. A number saved with a token Meta rejects
      // would sit in the cabinet looking connected.
      let displayPhone: string;
      try {
        displayPhone = (await graph.getPhoneNumber(phoneNumberId, accessToken)).displayPhoneNumber;
      } catch (error) {
        if (error instanceof GraphError) {
          throw new ApiError(400, `Meta не приняла эти данные: ${error.message}`);
        }
        throw error;
      }

      // The step everyone forgets. Without it Meta accepts the connection and delivers
      // nothing, which is indistinguishable from working until a client writes.
      try {
        await graph.subscribeApp(wabaId, accessToken);
      } catch (error) {
        if (error instanceof GraphError) {
          throw new ApiError(
            400,
            `Номер проверен, но не удалось подписать приложение на WABA: ${error.message}`,
          );
        }
        throw error;
      }

      try {
        const [row] = await db
          .insert(whatsappNumbers)
          .values({
            agentId: req.agent!.id,
            phoneNumberId,
            wabaId,
            displayPhone,
            // Bound to the phone number id: a token copied into another number's row
            // will not decrypt there.
            accessToken: encryptSecret(accessToken, credentialsKey(env), phoneNumberId),
            subscribedAt: new Date(),
          })
          .returning();
        return toApi(row!);
      } catch (error) {
        if (isDuplicate(error)) {
          throw new ApiError(409, 'Этот номер уже подключён к другому агенту');
        }
        throw error;
      }
    },
  );

  app.patch(
    '/api/agents/:agentId/whatsapp/numbers/:numberId',
    { preHandler: [guard, ownerOnly] },
    async (req): Promise<WhatsappNumber> => {
      const { numberId } = req.params as { numberId: string };
      const parsed = enabling.safeParse(req.body);
      if (!parsed.success) throw new ApiError(400, 'Не удалось разобрать настройку номера');

      const [row] = await db
        .update(whatsappNumbers)
        .set({ enabled: parsed.data.enabled })
        // The agent condition is what stops one account editing another's number even
        // when the identifier is guessed.
        .where(and(eq(whatsappNumbers.id, numberId), eq(whatsappNumbers.agentId, req.agent!.id)))
        .returning();

      if (!row) throw new ApiError(404, 'Номер не найден');
      return toApi(row);
    },
  );

  app.delete(
    '/api/agents/:agentId/whatsapp/numbers/:numberId',
    { preHandler: [guard, ownerOnly] },
    async (req): Promise<{ ok: true }> => {
      const { numberId } = req.params as { numberId: string };

      const [row] = await db
        .delete(whatsappNumbers)
        .where(and(eq(whatsappNumbers.id, numberId), eq(whatsappNumbers.agentId, req.agent!.id)))
        .returning({ id: whatsappNumbers.id });

      if (!row) throw new ApiError(404, 'Номер не найден');
      return { ok: true };
    },
  );

  app.get(
    '/api/agents/:agentId/whatsapp/setup',
    // Owner only: the verification string is a shared secret with Meta, and anyone holding
    // it plus the address can complete a handshake in our name.
    { preHandler: [guard, ownerOnly] },
    async (): Promise<WebhookSetup> => ({
      url: `${env.PUBLIC_URL}/api/whatsapp/webhook`,
      verifyToken: env.META_WEBHOOK_VERIFY_TOKEN,
    }),
  );
}
```

A `numberId` that is not a uuid makes Postgres raise on the comparison, which would turn a typo
into a 500. Both `PATCH` and `DELETE` therefore check the shape first, the way `requireAgent`
does, and answer `404 Номер не найден`.

- [ ] **Step 6: Register the routes**

In `server/src/api/server.ts`, after `registerAgentRoutes`:

```ts
  registerWhatsappNumberRoutes(app, db, env, guard, graph);
```

- [ ] **Step 7: Run everything**

```bash
npm --prefix server test
npm --prefix server run typecheck
```

Expected: PASS, fifteen new cases.

- [ ] **Step 8: Commit**

```bash
git add -A server packages/contract
git commit -m "Connect a WhatsApp number and subscribe the application to its WABA"
```
