import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { POOL_MAX, type Db } from '../src/db/client.js';
import { SANDBOX_TURNS } from '../src/db/turn-cap.js';
import {
  agents,
  capiEvents,
  capiSettings,
  contacts,
  conversations,
  kaspiPayments,
  kaspiSessions,
  messages,
  stages,
  whatsappNumbers,
} from '../src/db/schema.js';
import { runTurn } from '../src/lib/ai/turn.js';
import * as automationExecution from '../src/lib/automation/execution.js';
import * as automationPolicy from '../src/lib/automation/policy.js';
import { decideAutomation } from '../src/lib/automation/policy.js';
import { queueLead } from '../src/lib/capi/enqueue.js';
import { createCrmDeps } from '../src/lib/crm/live.js';
import { seedFunnel } from '../src/lib/funnel.js';
import { sessionAad } from '../src/lib/kaspi/service.js';
import { createAccountWithOwner } from '../src/lib/provision.js';
import { credentialsKey, encryptSecret } from '../src/lib/secret-box.js';
import { withDb } from './helpers/db.js';
import { testEnv } from './helpers/env.js';
import { fakeGraph, type FakeGraph } from './helpers/fake-graph.js';
import { fakeLinked } from './helpers/fake-linked.js';
import { fakeModel, type FakeModel } from './helpers/fake-model.js';

const PASSWORD = 'correct-horse-battery';
const OPENROUTER_KEY = 'sk-or-v1-0123456789abcdef';
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://rakurs:rakurs@localhost:55432/rakurs_test';
const env = testEnv({ KASPI_POS_URL: 'http://kaspi.test' });
const key = credentialsKey(env);

interface Gate {
  reached: Promise<void>;
  reach: () => void;
  wait: Promise<void>;
  release: () => void;
}

function gate(): Gate {
  let reach!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { reached, reach, wait, release };
}

function pauseAuthorizedEffect(boundary: Gate, target: number): void {
  const original = automationExecution.withAutomationEffect;
  let authorizedEffects = 0;
  vi.spyOn(automationExecution, 'withAutomationEffect').mockImplementation(
    (effectDb, input, purpose, effect) =>
      original(effectDb, input, purpose, async (tx, snapshot) => {
        // withAutomationEffect invokes this callback only after the final policy decision,
        // while its transaction-scoped agent lock is still held.
        authorizedEffects += 1;
        if (authorizedEffects === target) {
          boundary.reach();
          await boundary.wait;
        }
        return effect(tx, snapshot);
      }),
  );
}

let db: Db;
let app: FastifyInstance;
let graph: FakeGraph;
let linked: ReturnType<typeof fakeLinked>;
let agentId: string;
let conversationId: string;
let inboundMessageId: string;
let ownerJar: Record<string, string>;

async function patchOff() {
  return app.inject({
    method: 'PATCH',
    url: `/api/agents/${agentId}/ai`,
    cookies: ownerJar,
    payload: { responseMode: 'off' },
  });
}

async function patchRaceState(isSettled: () => boolean): Promise<'waiting' | 'settled'> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (isSettled()) return 'settled';
    const rows = await db.execute(sql`
      select exists (
        select 1
        from pg_stat_activity
        where datname = current_database()
          and state = 'active'
          and wait_event_type = 'Lock'
          and query like '%pg_advisory_xact_lock%'
      ) as waiting
    `);
    if (Boolean([...rows][0]?.waiting)) return 'waiting';
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for the settings PATCH to settle or wait on the lock');
}

async function racePatch(effect: Promise<unknown>, boundary: Gate) {
  await boundary.reached;
  let settled = false;
  const patch = patchOff().then((response) => {
    settled = true;
    return response;
  });
  const state = await patchRaceState(() => settled);
  boundary.release();
  const [effectResult, patchResult] = await Promise.all([effect, patch]);
  expect(patchResult.statusCode).toBe(200);
  expect(state).toBe('waiting');
  return effectResult;
}

function answer(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    reply: 'Здравствуйте!',
    stageId: null,
    fields: {},
    handoff: null,
    usedItemIds: [],
    ...overrides,
  });
}

async function login(): Promise<Record<string, string>> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'owner@example.com', password: PASSWORD },
  });
  const cookie = response.cookies[0]!;
  return { [cookie.name]: cookie.value };
}

beforeEach(async () => {
  db = await withDb();
  const { accountId } = await createAccountWithOwner(db, {
    company: 'Linearization test',
    email: 'owner@example.com',
    name: 'Owner',
    initials: 'OW',
    password: PASSWORD,
  });
  agentId = randomUUID();
  await db.insert(agents).values({
    id: agentId,
    accountId,
    name: 'Linearization',
    aiEnabled: true,
    responseMode: 'live',
    openrouterKey: encryptSecret(OPENROUTER_KEY, key, agentId),
  });
  await seedFunnel(db, agentId);

  const [number] = await db
    .insert(whatsappNumbers)
    .values({
      agentId,
      phoneNumberId: 'linearization-number',
      wabaId: 'linearization-waba',
      displayPhone: '+7 700 000 00 00',
      accessToken: encryptSecret('EAAG-token', key, 'linearization-number'),
    })
    .returning();
  const [contact] = await db
    .insert(contacts)
    .values({ agentId, phone: '77001234567', name: 'Айгуль' })
    .returning();
  const [conversation] = await db
    .insert(conversations)
    .values({
      agentId,
      contactId: contact!.id,
      whatsappNumberId: number!.id,
      lastInboundAt: new Date(),
      lastMessageAt: new Date(),
    })
    .returning();
  conversationId = conversation!.id;
  const [message] = await db
    .insert(messages)
    .values({
      conversationId,
      direction: 'in',
      author: 'client',
      kind: 'text',
      body: 'Здравствуйте',
      sentAt: new Date(),
    })
    .returning();
  inboundMessageId = message!.id;

  await db.insert(kaspiSessions).values({
    agentId,
    credentials: encryptSecret(
      JSON.stringify({ tokenSN: 'cashier-token', vtokenSecret: 'private-secret' }),
      key,
      sessionAad(agentId),
    ),
  });
  await db.insert(capiSettings).values({
    agentId,
    datasetId: '123456789',
    accessToken: encryptSecret('EAA-capi-token', key, agentId),
    enabled: true,
  });

  graph = fakeGraph();
  linked = fakeLinked();
  app = buildServer(env, db, { graph, linked });
  await app.ready();
  ownerJar = await login();
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await app.close();
});

describe('response mode linearization', () => {
  it('keeps settings PATCH outside its lock transaction while admission is saturated', async () => {
    let slotTransactionStarts = 0;
    const slotTx = {
      execute: async () => [],
    } as unknown as automationExecution.AutomationTransaction;
    const slotDb = {
      transaction: async <T>(
        effect: (tx: automationExecution.AutomationTransaction) => Promise<T>,
      ) => {
        slotTransactionStarts += 1;
        return effect(slotTx);
      },
    } as unknown as Db;
    const blockers = Array.from({ length: SANDBOX_TURNS }, gate);
    const slotUsers = blockers.map((blocker) =>
      automationExecution.withAgentAutomationLock(slotDb, agentId, async () => blocker.wait),
    );
    let patch: ReturnType<typeof patchOff> | undefined;

    try {
      await vi.waitFor(() => {
        expect(slotTransactionStarts).toBe(SANDBOX_TURNS);
      });

      let settled = false;
      patch = patchOff().then((response) => {
        settled = true;
        return response;
      });
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(settled).toBe(false);

      blockers[0]!.release();
      expect((await patch).statusCode).toBe(200);
    } finally {
      for (const blocker of blockers) blocker.release();
      await Promise.allSettled(slotUsers);
      if (patch) await patch;
    }
  });

  it('keeps a root-pool connection available when same-agent lock admission is saturated', async () => {
    const observer = postgres(TEST_DATABASE_URL, { max: 1 });
    const boundary = gate();
    const forceHolderExit = gate();
    const nestedStarted = gate();
    let nestedQuery: Promise<unknown> | undefined;
    let transactionStarts = 0;
    const originalTransaction = db.transaction.bind(db);
    const admittedDb = new Proxy(db, {
      get(target, property) {
        if (property === 'transaction') {
          return <T>(effect: Parameters<Db['transaction']>[0]): Promise<T> => {
            transactionStarts += 1;
            return originalTransaction(effect) as Promise<T>;
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as Db;
    const lockUsers: Promise<unknown>[] = [];

    try {
      const holder = automationExecution.withAgentAutomationLock(
        admittedDb,
        agentId,
        async () => {
          boundary.reach();
          await boundary.wait;
          nestedQuery = Promise.resolve(db.execute(sql`select 1`));
          nestedStarted.reach();
          await Promise.race([nestedQuery, forceHolderExit.wait]);
        },
      );
      lockUsers.push(holder);
      await boundary.reached;

      for (let index = 1; index < POOL_MAX; index += 1) {
        lockUsers.push(
          automationExecution.withAgentAutomationLock(admittedDb, agentId, async () => undefined),
        );
      }
      await new Promise((resolve) => setImmediate(resolve));
      const openedBeforeRelease = transactionStarts;

      await vi.waitFor(async () => {
        const [row] = await observer<{ waiters: number }[]>`
          select count(*)::int as waiters
          from pg_stat_activity
          where datname = current_database()
            and state = 'active'
            and wait_event_type = 'Lock'
            and query like '%pg_advisory_xact_lock%'
        `;
        expect(row!.waiters).toBe(openedBeforeRelease - 1);
      });

      boundary.release();
      await nestedStarted.reached;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const completedBeforeDeadline = await Promise.race([
        nestedQuery!.then(() => true),
        new Promise<boolean>((resolve) => {
          timeout = setTimeout(() => resolve(false), 500);
        }),
      ]);
      if (timeout) clearTimeout(timeout);

      expect({ openedBeforeRelease, completedBeforeDeadline }).toEqual({
        openedBeforeRelease: SANDBOX_TURNS,
        completedBeforeDeadline: true,
      });
    } finally {
      boundary.release();
      forceHolderExit.release();
      await Promise.allSettled(lockUsers);
      if (nestedQuery) await nestedQuery;
      await observer.end();
    }
  });

  it('holds the agent lock from the final reply authorization through the send', async () => {
    const model = fakeModel(answer());
    const boundary = gate();
    pauseAuthorizedEffect(boundary, 1);

    await racePatch(
      runTurn(db, { model, graph, linked, key }, { agentId, conversationId }),
      boundary,
    );

    expect(graph.calls.filter((call) => call.method === 'sendText')).toHaveLength(1);
  });

  it('holds the agent lock from the final handoff authorization through the mutation', async () => {
    const model = fakeModel(
      answer({
        reply: 'Передаю диалог коллеге.',
        handoff: { reason: 'Нужна помощь специалиста' },
      }),
    );
    const boundary = gate();
    pauseAuthorizedEffect(boundary, 1);

    await racePatch(
      runTurn(db, { model, graph, linked, key }, { agentId, conversationId }),
      boundary,
    );

    const [conversation] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    expect(conversation!.aiEnabled).toBe(false);
  });

  it('holds the agent lock from checkout authorization through the real provider call', async () => {
    const boundary = gate();
    pauseAuthorizedEffect(boundary, 1);
    const kaspi = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ StatusCode: 0, Data: { Id: 'operation-1' } })),
    );
    vi.stubGlobal('fetch', kaspi);

    await racePatch(
      createCrmDeps(db, env, { model: fakeModel(), graph, linked, key }).checkout!({
        agentId,
        conversationId,
        phone: '77009999999',
        summary: 'Один товар',
        intent: {
          method: 'invoice',
          messageId: inboundMessageId,
          quote: 'Отправьте счёт',
          amount: '5000',
          amountMessageId: inboundMessageId,
        },
      }),
      boundary,
    );

    expect(kaspi).toHaveBeenCalledTimes(1);
    expect(await db.select().from(kaspiPayments)).toHaveLength(1);
  });

  it('holds the agent lock from final checkout-message authorization through the send', async () => {
    const boundary = gate();
    pauseAuthorizedEffect(boundary, 2);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ StatusCode: 0, Data: { Id: 'operation-2' } })),
      ),
    );

    await racePatch(
      createCrmDeps(db, env, { model: fakeModel(), graph, linked, key }).checkout!({
        agentId,
        conversationId,
        phone: '77009999999',
        summary: 'Один товар',
        intent: {
          method: 'invoice',
          messageId: inboundMessageId,
          quote: 'Отправьте счёт',
          amount: '5000',
          amountMessageId: inboundMessageId,
        },
      }),
      boundary,
    );

    expect(graph.calls.filter((call) => call.method === 'sendText')).toHaveLength(1);
  });

  it('holds the agent lock from final CAPI authorization through the queue insert', async () => {
    const [qualified] = (await db.select().from(stages).where(eq(stages.agentId, agentId))).filter(
      (stage) => stage.kind === 'qualified',
    );
    await db
      .update(conversations)
      .set({ stageId: qualified!.id, stageSetAt: new Date(), ctwaClid: 'click-1' })
      .where(eq(conversations.id, conversationId));
    const boundary = gate();

    await racePatch(
      queueLead(db, {
        agentId,
        conversationId,
        canQueue: async (effectDb) => {
          const snapshot = await automationPolicy.loadAutomationSnapshot(effectDb, {
            agentId,
            conversationId,
          });
          const allowed = snapshot !== null && decideAutomation(snapshot, 'crm').allowed;
          boundary.reach();
          await boundary.wait;
          return allowed;
        },
      }),
      boundary,
    );

    expect(await db.select().from(capiEvents)).toHaveLength(1);
  });
});
