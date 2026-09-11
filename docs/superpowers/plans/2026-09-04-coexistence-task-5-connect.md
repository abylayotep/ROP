# Task 5: The coexistence connect route

Part of [WhatsApp Coexistence](2026-09-04-whatsapp-coexistence.md). Depends on Tasks 3 and 4.

**Files:**
- Create: `server/src/api/whatsapp-coexistence.ts`
- Modify: `server/src/api/server.ts:95` (register after the numbers routes)
- Modify: `server/src/api/whatsapp-numbers.ts` (PATCH refuses a token for coexistence rows)
- Test: `server/test/whatsapp-coexistence.test.ts` (new), `server/test/whatsapp-numbers.test.ts` (one case)

**Interfaces:**
- Consumes: `toApi` (Task 3), `graph.exchangeCode / listPhoneNumbers / getPhoneNumber / subscribeApp / requestSmbAppData` (Task 4), `encryptSecret`, `credentialsKey`, `requireAgent`, `ApiError`, `withoutSecret`, `GraphError`.
- Produces: `GET /api/agents/:agentId/whatsapp/embedded-signup` → `EmbeddedSignupSetup`; `POST /api/agents/:agentId/whatsapp/coexistence` (body `CoexistenceConnection`) → `WhatsappNumber`.

- [ ] **Step 1: Failing tests**

Create `server/test/whatsapp-coexistence.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { agents, whatsappNumbers } from '../src/db/schema.js';
import { createAccountWithOwner } from '../src/lib/provision.js';
import { decryptSecret } from '../src/lib/secret-box.js';
import { GraphError } from '../src/lib/whatsapp/graph.js';
import { withDb } from './helpers/db.js';
import { testEnv } from './helpers/env.js';
import { fakeGraph, type FakeGraph } from './helpers/fake-graph.js';

const env = testEnv({ META_APP_ID: '1585667806534384', META_ES_CONFIG_ID: '777' });
const PASSWORD = 'correct-horse-battery';

let app: FastifyInstance;
let db: Awaited<ReturnType<typeof withDb>>;
let graph: FakeGraph;
let agentId: string;
let jar: Record<string, string>;

async function login(email: string) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: PASSWORD } });
  const cookie = res.cookies[0]!;
  return { [cookie.name]: cookie.value };
}

async function boot(overrides: Parameters<typeof fakeGraph>[0] = {}) {
  db = await withDb();
  graph = fakeGraph(overrides);
  app = buildServer(env, db, { graph });
  await app.ready();
  const { accountId } = await createAccountWithOwner(db, {
    company: 'Sealhouse',
    email: 'owner@example.com',
    name: 'Владелец',
    initials: 'ВЛ',
    password: PASSWORD,
  });
  const [agent] = await db.insert(agents).values({ accountId, name: 'Sealhouse' }).returning();
  agentId = agent!.id;
  jar = await login('owner@example.com');
}

beforeEach(() => boot());

const connect = (payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: `/api/agents/${agentId}/whatsapp/coexistence`, cookies: jar, payload });

describe('embedded signup setup', () => {
  it('gives the owner the app id and the configuration id, nothing secret', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/agents/${agentId}/whatsapp/embedded-signup`, cookies: jar });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ appId: '1585667806534384', configId: '777' });
    expect(res.body).not.toContain(env.META_APP_SECRET);
  });
});

describe('connecting the phone number', () => {
  it('exchanges the code, checks the number, subscribes, stores, and requests both syncs', async () => {
    const res = await connect({ code: 'AQD-code', wabaId: '932', phoneNumberId: '136', businessId: '877' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      phoneNumberId: '136',
      wabaId: '932',
      connectionKind: 'coexistence',
      subscribed: true,
      historyProgress: 0,
      syncError: null,
    });

    expect(graph.calls.map((c) => c.method)).toEqual([
      'exchangeCode',
      'getPhoneNumber',
      'subscribeApp',
      'requestSmbAppData',
      'requestSmbAppData',
    ]);
    expect(graph.calls[0]!.args).toEqual(['AQD-code', '1585667806534384', env.META_APP_SECRET]);
    expect(graph.calls[3]!.args[2]).toBe('smb_app_state_sync');
    expect(graph.calls[4]!.args[2]).toBe('history');

    const [row] = await db.select().from(whatsappNumbers);
    expect(row!.businessId).toBe('877');
    expect(row!.syncRequestedAt).not.toBeNull();
    expect(decryptSecret(row!.accessToken, Buffer.from(env.CREDENTIALS_KEY, 'base64'), '136')).toBe('EAAB-business-token');
  });

  it('resolves the number from the WABA when Embedded Signup reported only the WABA', async () => {
    const res = await connect({ code: 'AQD-code', wabaId: '932' });

    expect(res.statusCode).toBe(200);
    expect(res.json().phoneNumberId).toBe('136');
    expect(graph.calls.map((c) => c.method)).toContain('listPhoneNumbers');
  });

  it('refuses when the WABA has several numbers and none was named', async () => {
    await boot({
      listPhoneNumbers: async () => [
        { id: '1', displayPhoneNumber: '+7 1', verifiedName: 'a', platformType: null, isOnBizApp: true },
        { id: '2', displayPhoneNumber: '+7 2', verifiedName: 'b', platformType: null, isOnBizApp: true },
      ],
    });

    const res = await connect({ code: 'AQD-code', wabaId: '932' });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('У аккаунта несколько номеров. Повторите подключение и выберите номер в окне Meta.');
    expect(await db.select().from(whatsappNumbers)).toHaveLength(0);
  });

  it('stores nothing when Meta rejects the code, and hides the secret', async () => {
    await boot({
      exchangeCode: async () => {
        throw new GraphError('Invalid verification code test-app-secret', 400, 100);
      },
    });

    const res = await connect({ code: 'stale', wabaId: '932', phoneNumberId: '136' });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('Meta не приняла подтверждение: Invalid verification code <токен скрыт>');
    expect(await db.select().from(whatsappNumbers)).toHaveLength(0);
  });

  it('refuses a number that is not on the phone app', async () => {
    await boot({
      getPhoneNumber: async () => ({
        id: '136',
        displayPhoneNumber: '+7 771',
        verifiedName: 'x',
        platformType: 'CLOUD_API',
        isOnBizApp: false,
      }),
    });

    const res = await connect({ code: 'AQD-code', wabaId: '932', phoneNumberId: '136' });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('Номер не подключён к приложению WhatsApp Business на телефоне');
    expect(await db.select().from(whatsappNumbers)).toHaveLength(0);
  });

  it('keeps the number and records the error when a sync request is refused', async () => {
    await boot({
      requestSmbAppData: async (_id, _t, syncType) => {
        if (syncType === 'history') throw new GraphError('History sync already requested', 400, 2593002);
        return { requestId: 'req-contacts' };
      },
    });

    const res = await connect({ code: 'AQD-code', wabaId: '932', phoneNumberId: '136' });

    expect(res.statusCode).toBe(200);
    expect(res.json().syncError).toBe('History sync already requested');
    const [row] = await db.select().from(whatsappNumbers);
    expect(row!.syncRequestedAt).toBeNull();
  });

  it('says the number is already connected on a repeat', async () => {
    await connect({ code: 'one', wabaId: '932', phoneNumberId: '136' });

    const res = await connect({ code: 'two', wabaId: '932', phoneNumberId: '136' });

    expect(res.statusCode).toBe(409);
    expect(res.json().message).toBe('Этот номер уже подключён к этому агенту');
  });

  it('is owner only', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/agents/${agentId}/whatsapp/coexistence`, payload: { code: 'x', wabaId: '932' } });

    expect(res.statusCode).toBe(401);
  });
});
```

And in `server/test/whatsapp-numbers.test.ts`, inside `describe('replacing a token')` (or the nearest PATCH block), add:

```ts
  it('refuses a pasted token for a coexistence number', async () => {
    const [row] = await db
      .update(whatsappNumbers)
      .set({ connectionKind: 'coexistence' })
      .where(eq(whatsappNumbers.phoneNumberId, '136'))
      .returning();

    const res = await patch(row!.id, { accessToken: 'EAAG-new' });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('Токен этого номера выдаёт Meta при подключении с телефона, вручную его не заменить');
  });
```

(seed a number first with `await connect(valid)` if the block does not already.)

- [ ] **Step 2: Run, expect failure**

`npm --prefix server test -- whatsapp-coexistence` → 404s: the routes do not exist.

- [ ] **Step 3: The routes**

Create `server/src/api/whatsapp-coexistence.ts`:

```ts
import type { CoexistenceConnection, EmbeddedSignupSetup, WhatsappNumber } from '@rakurs/contract';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { whatsappNumbers } from '../db/schema.js';
import type { Env } from '../env.js';
import { ApiError } from '../lib/errors.js';
import { credentialsKey, encryptSecret } from '../lib/secret-box.js';
import { GraphError, withoutSecret, type GraphClient, type PhoneNumber } from '../lib/whatsapp/graph.js';
import { requireAgent } from './require-agent.js';
import { toApi } from './whatsapp-numbers.js';

const connection = z.object({
  code: z.string().trim().min(1),
  wabaId: z.string().trim().min(1),
  phoneNumberId: z.string().trim().min(1).optional(),
  businessId: z.string().trim().min(1).optional(),
});

const isDuplicate = (error: unknown): boolean => {
  const cause = error instanceof Error ? error.cause : undefined;
  return typeof cause === 'object' && cause !== null && (cause as { code?: string }).code === '23505';
};

/**
 * Coexistence: the number that already lives in the WhatsApp Business app on a phone.
 *
 * Embedded Signup ran in the browser and produced a code that dies in thirty seconds. This
 * route spends it: token, number, subscription, row, and both one-shot sync requests, in one
 * go. Nothing here is deferred to a job, because Meta's 24-hour deadline on the syncs is a
 * cliff and a queue is one more place to fall off it.
 */
export function registerWhatsappCoexistenceRoutes(
  app: FastifyInstance,
  db: Db,
  env: Env,
  guard: preHandlerHookHandler,
  graph: GraphClient,
): void {
  const ownerOnly = requireAgent(db, { role: 'owner' });

  app.get(
    '/api/agents/:agentId/whatsapp/embedded-signup',
    { preHandler: [guard, ownerOnly] },
    async (): Promise<EmbeddedSignupSetup> => ({
      appId: env.META_APP_ID,
      configId: env.META_ES_CONFIG_ID,
    }),
  );

  app.post(
    '/api/agents/:agentId/whatsapp/coexistence',
    { preHandler: [guard, ownerOnly] },
    async (req): Promise<WhatsappNumber> => {
      const parsed = connection.safeParse(req.body as CoexistenceConnection);
      if (!parsed.success) throw new ApiError(400, 'Meta не вернула данные для подключения');
      const { code, wabaId, businessId } = parsed.data;

      let token: string;
      try {
        token = await graph.exchangeCode(code, env.META_APP_ID, env.META_APP_SECRET);
      } catch (error) {
        if (error instanceof GraphError) {
          throw new ApiError(400, `Meta не приняла подтверждение: ${withoutSecret(error.message, env.META_APP_SECRET)}`);
        }
        throw error;
      }

      // The finish event of the coexistence flow may carry only the WABA. One number on it
      // is the common case; two is the owner's choice to make in Meta's own window.
      let number: PhoneNumber;
      try {
        if (parsed.data.phoneNumberId) {
          number = await graph.getPhoneNumber(parsed.data.phoneNumberId, token);
        } else {
          const all = await graph.listPhoneNumbers(wabaId, token);
          if (all.length !== 1) {
            throw new ApiError(400, 'У аккаунта несколько номеров. Повторите подключение и выберите номер в окне Meta.');
          }
          number = await graph.getPhoneNumber(all[0]!.id, token);
        }
      } catch (error) {
        if (error instanceof GraphError) {
          throw new ApiError(400, `Meta не отдала номер: ${withoutSecret(error.message, token)}`);
        }
        throw error;
      }

      if (!number.isOnBizApp) {
        throw new ApiError(400, 'Номер не подключён к приложению WhatsApp Business на телефоне');
      }

      try {
        await graph.subscribeApp(wabaId, token);
      } catch (error) {
        if (error instanceof GraphError) {
          throw new ApiError(400, `Номер проверен, но не удалось подписать приложение на WABA: ${withoutSecret(error.message, token)}`);
        }
        throw error;
      }

      let row: typeof whatsappNumbers.$inferSelect;
      try {
        [row] = (await db
          .insert(whatsappNumbers)
          .values({
            agentId: req.agent!.id,
            phoneNumberId: number.id,
            wabaId,
            businessId: businessId ?? null,
            displayPhone: number.displayPhoneNumber,
            accessToken: encryptSecret(token, credentialsKey(env), number.id),
            subscribedAt: new Date(),
            connectionKind: 'coexistence',
          })
          .returning()) as [typeof whatsappNumbers.$inferSelect];
      } catch (error) {
        if (isDuplicate(error)) {
          const [existing] = await db
            .select({ agentId: whatsappNumbers.agentId })
            .from(whatsappNumbers)
            .where(eq(whatsappNumbers.phoneNumberId, number.id));
          throw new ApiError(
            409,
            existing?.agentId === req.agent!.id
              ? 'Этот номер уже подключён к этому агенту'
              : 'Этот номер уже подключён к другому агенту',
          );
        }
        throw error;
      }

      // Both are one-shot on Meta's side. A refusal is written down, not retried: a second
      // attempt would only replace a clear error with «already requested».
      let syncError: string | null = null;
      for (const syncType of ['smb_app_state_sync', 'history'] as const) {
        try {
          await graph.requestSmbAppData(number.id, token, syncType);
        } catch (error) {
          if (!(error instanceof GraphError)) throw error;
          syncError = withoutSecret(error.message, token);
          break;
        }
      }
      const [updated] = await db
        .update(whatsappNumbers)
        .set(syncError ? { syncError } : { syncRequestedAt: new Date() })
        .where(eq(whatsappNumbers.id, row.id))
        .returning();
      return toApi(updated!);
    },
  );
}
```

- [ ] **Step 4: Register and guard the PATCH**

`server/src/api/server.ts`: import `registerWhatsappCoexistenceRoutes` from `./whatsapp-coexistence.js` and call it right after `registerWhatsappNumberRoutes(app, db, env, guard, graph);` with the same arguments.

`server/src/api/whatsapp-numbers.ts`, in the PATCH handler after `if (!current) throw …`:

```ts
      if (accessToken !== undefined && current.connectionKind === 'coexistence') {
        // Meta issued this token during Embedded Signup; a pasted one would belong to a
        // different app or user and stop the phone's mirror from working.
        throw new ApiError(400, 'Токен этого номера выдаёт Meta при подключении с телефона, вручную его не заменить');
      }
```

- [ ] **Step 5: Run everything**

```bash
npm --prefix server test
npm --prefix server run typecheck
```

Expected: green.

- [ ] **Step 6: Commit**

```bash
git add server/src/api/whatsapp-coexistence.ts server/src/api/server.ts server/src/api/whatsapp-numbers.ts server/test/whatsapp-coexistence.test.ts server/test/whatsapp-numbers.test.ts
git commit -m "Connect the phone's WhatsApp number through Embedded Signup"
```
