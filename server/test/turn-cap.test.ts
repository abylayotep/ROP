/**
 * The in-flight cap that protects the connection pool is one counter, not two.
 *
 * `api/ai.ts`'s sandbox and `api/coach.ts`'s coach each hold a database connection for as
 * long as the model takes to think, exactly the shape `db/client.ts`'s `POOL_MAX` comment
 * warns about — and each was capped at `SANDBOX_TURNS` on its own counter. That leaves the
 * pool exposed exactly the way the comment reasons against: three sandbox turns and three
 * coaching turns in flight at once hold six of ten connections, not three, because neither
 * counter knows the other exists. This file proves the fix — one shared counter — by filling
 * it from one feature and showing the other is refused, not merely that each refuses itself.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SANDBOX_TURNS } from '../src/api/ai.js';
import { buildServer } from '../src/api/server.js';
import type { Db } from '../src/db/client.js';
import { agents, aiSandboxSessions, whatsappNumbers } from '../src/db/schema.js';
import type { Completion, CompletionInput, ModelClient } from '../src/lib/ai/openrouter.js';
import { runSimulatorTurn } from '../src/lib/ai/simulator.js';
import { keyAad } from '../src/lib/ai/turn.js';
import { createAccountWithOwner } from '../src/lib/provision.js';
import { encryptSecret } from '../src/lib/secret-box.js';
import { withDb } from './helpers/db.js';
import { testEnv } from './helpers/env.js';
import { fakeGraph } from './helpers/fake-graph.js';
import { fakeLinked } from './helpers/fake-linked.js';
import { fakeModel } from './helpers/fake-model.js';

const env = testEnv();
const key = Buffer.from(env.CREDENTIALS_KEY, 'base64');
const PASSWORD = 'correct-horse-battery';
const OPENROUTER_KEY = 'sk-or-v1-shared-cap-0123456789';

interface HangableModel extends ModelClient {
  calls: CompletionInput[];
  hang(): void;
  release(): void;
}

/**
 * A model that hangs until told to answer, and whose answer satisfies both `REPLY_SCHEMA`
 * (the sandbox, via `runTurn`) and `COACH_SCHEMA` (the coach, via `runCoach`) at once —
 * `reply` and `message` are each required by one schema and ignored by the other, and every
 * other key either schema wants has a default. One fake model this way stands in for both
 * routes, the way `server.ts` itself wires one `ModelClient` to both.
 */
function hangableModel(): HangableModel {
  const calls: CompletionInput[] = [];
  let gate: Promise<void> | null = null;
  let open = () => {};
  return {
    calls,
    hang() {
      gate = new Promise((resolve) => {
        open = resolve;
      });
    },
    release() {
      open();
      gate = null;
    },
    async complete(input): Promise<Completion> {
      calls.push(input);
      if (gate) await gate;
      return {
        text: JSON.stringify({ reply: 'Ответ.', message: 'Понял.', proposal: null }),
        promptTokens: 100,
        completionTokens: 20,
        cost: '0.00010000',
      };
    },
  };
}

let db: Db;
let app: FastifyInstance;
let agentId: string;
let jar: Record<string, string>;
let model: HangableModel;

async function login() {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'owner@example.com', password: PASSWORD },
  });
  const cookie = res.cookies[0]!;
  return { [cookie.name]: cookie.value };
}

function sandbox(text: string) {
  return app.inject({
    method: 'POST',
    url: `/api/agents/${agentId}/ai/sandbox`,
    cookies: jar,
    payload: { text },
  });
}

function coach(text: string) {
  return app.inject({
    method: 'POST',
    url: `/api/agents/${agentId}/coach/messages`,
    cookies: jar,
    payload: { text },
  });
}

beforeEach(async () => {
  db = await withDb();
  const { accountId } = await createAccountWithOwner(db, {
    company: 'Общий пул',
    email: 'owner@example.com',
    name: 'Владелец',
    initials: 'ВЛ',
    password: PASSWORD,
  });

  // Minted here rather than read back, the same reason `coach-api.test.ts` does: the
  // OpenRouter key is sealed against this id before the row exists.
  agentId = randomUUID();
  await db.insert(agents).values({
    id: agentId,
    accountId,
    name: 'Общий пул',
    openrouterKey: encryptSecret(OPENROUTER_KEY, key, keyAad(agentId)),
  });
  // The sandbox refuses without a number to answer on; the coach does not need one.
  await db.insert(whatsappNumbers).values({
    agentId,
    phoneNumberId: randomUUID(),
    wabaId: randomUUID(),
    displayPhone: '+7 700 000 00 00',
    accessToken: encryptSecret('unused', key, randomUUID()),
  });

  model = hangableModel();
  app = buildServer(env, db, { graph: fakeGraph(), model });
  await app.ready();
  jar = await login();
});

afterEach(async () => {
  await app.close();
});

describe('the shared in-flight cap', () => {
  it('a sandbox holding every slot leaves the coach refused, not merely itself', async () => {
    model.hang();
    const running = [0, 1, 2].map(() => sandbox('Сколько стоит доставка?'));
    // Wait until all three are actually inside the model call, not merely dispatched — the
    // same reason `ai-inbound.test.ts` and `coach-api.test.ts` wait on `calls.length` before
    // firing the request meant to be refused.
    while (model.calls.length < SANDBOX_TURNS) await new Promise((resolve) => setImmediate(resolve));

    const refused = await coach('Так нельзя.');
    expect(refused.statusCode).toBe(429);
    // Refused, not run: the coaching call never reached the model.
    expect(model.calls).toHaveLength(SANDBOX_TURNS);

    const [session] = await db.insert(aiSandboxSessions)
      .values({ accountId: (await db.select().from(agents))[0]!.accountId, agentId })
      .returning();
    const simulator = () => runSimulatorTurn(db, {
      model: fakeModel(JSON.stringify({ reply: 'Ответ.', stageId: null,
        fields: {}, handoff: null, usedItemIds: [] })),
      graph: fakeGraph(), linked: fakeLinked(), key,
    }, { agentId, sessionId: session!.id, text: 'Здравствуйте', revision: 0 });
    await expect(simulator()).rejects.toMatchObject({ statusCode: 429 });

    model.release();
    for (const res of await Promise.all(running)) expect(res.statusCode).toBe(200);

    // The slot came back, so the coach runs once the sandbox lets go of it.
    expect((await coach('Так нельзя.')).statusCode).toBe(200);
    expect(await simulator()).toMatchObject({ outcome: 'sent', revision: 1 });
  });

  it('a coach holding every slot leaves the sandbox refused, the other direction', async () => {
    model.hang();
    const running = [0, 1, 2].map(() => coach('Так нельзя.'));
    while (model.calls.length < SANDBOX_TURNS) await new Promise((resolve) => setImmediate(resolve));

    const refused = await sandbox('Сколько стоит доставка?');
    expect(refused.statusCode).toBe(429);
    expect(model.calls).toHaveLength(SANDBOX_TURNS);

    model.release();
    for (const res of await Promise.all(running)) expect(res.statusCode).toBe(200);

    expect((await sandbox('Сколько стоит доставка?')).statusCode).toBe(200);
  });
});
