import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import type { Db } from '../src/db/client.js';
import {
  agents,
  contacts,
  conversations,
  kbDrafts,
  messages,
  testCases,
  testResults,
  testRuns,
  whatsappNumbers,
} from '../src/db/schema.js';
import type { CompletionInput, ModelClient } from '../src/lib/ai/openrouter.js';
import { keyAad } from '../src/lib/ai/turn.js';
import type { DraftOp } from '../src/lib/drafts/ops.js';
import { addMember, createAccountWithOwner } from '../src/lib/provision.js';
import { encryptSecret } from '../src/lib/secret-box.js';
import { withDb } from './helpers/db.js';
import { testEnv } from './helpers/env.js';
import { fakeGraph } from './helpers/fake-graph.js';

const env = testEnv();
const key = Buffer.from(env.CREDENTIALS_KEY, 'base64');
const PASSWORD = 'correct-horse-battery';
const OPENROUTER_KEY = 'sk-or-v1-test-cases-api-0123456789';

/**
 * A model whose reply is scripted per test, the same shape `coach-api.test.ts`'s own
 * `fakeCoachModel` gives `runCoach` — `suggest-cases` calls the model directly with its own
 * `{ cases: [...] }` schema, not through `runTurn`, so the raw JSON this hands back is that
 * shape rather than a turn's `{reply, stageId, ...}`.
 */
interface FakeModel extends ModelClient {
  calls: CompletionInput[];
  reply(payload: { cases: { title: string; messages: string[] }[] }): void;
}

function fakeModel(): FakeModel {
  const calls: CompletionInput[] = [];
  let script: { cases: { title: string; messages: string[] }[] } = { cases: [] };
  return {
    calls,
    reply(payload) {
      script = payload;
    },
    async complete(input) {
      calls.push(input);
      return {
        text: JSON.stringify(script),
        promptTokens: 100,
        completionTokens: 20,
        cost: '0.00010000',
      };
    },
  };
}

let app: FastifyInstance;
let db: Db;
let agentId: string;
let numberId: string;
let jar: Record<string, string>;
let memberJar: Record<string, string>;
let model: FakeModel;

async function login(email = 'owner@example.com') {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: PASSWORD },
  });
  const cookie = res.cookies[0]!;
  return { [cookie.name]: cookie.value };
}

const cases = () => `/api/agents/${agentId}/test-cases`;
const drafts = () => `/api/agents/${agentId}/drafts`;

function post(payload: unknown) {
  return app.inject({ method: 'POST', cookies: jar, url: cases(), payload: payload as object });
}

/** Seeds a conversation with the given lines, spaced a second apart so `sentAt` orders them
 * deterministically regardless of how fast the inserts themselves run. */
async function dialogWith(lines: { author: 'client' | 'agent'; body: string }[]) {
  const [contact] = await db
    .insert(contacts)
    .values({ agentId, phone: `+7700${Math.floor(Math.random() * 1e7)}` })
    .returning();
  const [conversation] = await db
    .insert(conversations)
    .values({ agentId, contactId: contact!.id, whatsappNumberId: numberId })
    .returning();

  let t = Date.now();
  for (const line of lines) {
    await db.insert(messages).values({
      conversationId: conversation!.id,
      direction: line.author === 'client' ? 'in' : 'out',
      author: line.author === 'client' ? 'client' : 'ai',
      kind: 'text',
      body: line.body,
      sentAt: new Date(t),
    });
    t += 1000;
  }
  return { conversationId: conversation!.id };
}

async function openDraft(ops: DraftOp[] = []) {
  const [row] = await db
    .insert(kbDrafts)
    .values({ agentId, title: 'Черновик', origin: 'manual', status: 'open', ops, base: {} })
    .returning();
  return row!;
}

beforeEach(async () => {
  db = await withDb();
  const { accountId } = await createAccountWithOwner(db, {
    company: 'Сафина',
    email: 'owner@example.com',
    name: 'Владелец',
    initials: 'ВЛ',
    password: PASSWORD,
  });
  await addMember(db, {
    company: 'Сафина',
    email: 'member@example.com',
    name: 'Оператор',
    initials: 'ОП',
    password: PASSWORD,
    role: 'member',
  });

  // Minted here rather than read back — the OpenRouter key is sealed against this id before
  // the row exists, the same reason `draft-run-api.test.ts` does it this way.
  agentId = randomUUID();
  await db.insert(agents).values({
    id: agentId,
    accountId,
    name: 'Сафина',
    openrouterKey: encryptSecret(OPENROUTER_KEY, key, keyAad(agentId)),
  });

  const [number] = await db
    .insert(whatsappNumbers)
    .values({
      agentId,
      phoneNumberId: randomUUID(),
      wabaId: randomUUID(),
      displayPhone: '+7 700 000 00 00',
      accessToken: 'unused',
    })
    .returning();
  numberId = number!.id;

  model = fakeModel();
  app = buildServer(env, db, { graph: fakeGraph(), model });
  await app.ready();
  jar = await login();
  memberJar = await login('member@example.com');
});

afterEach(async () => {
  await app.close();
});

describe('keeping cases by hand', () => {
  it('creates a case from the customer messages and an expectation', async () => {
    const res = await post({
      title: 'Про скидку',
      messages: ['дадите скидку?'],
      expectation: 'не должен обещать скидку',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().origin).toBe('manual');
    expect(res.json().messages).toEqual(['дадите скидку?']);
    expect(res.json().expectation).toBe('не должен обещать скидку');
    expect(res.json().enabled).toBe(true);
  });

  it('refuses eleven messages and a message over the length limit', async () => {
    expect((await post({ title: 'Много', messages: Array(11).fill('раз') })).statusCode).toBe(400);
    expect((await post({ title: 'Длинно', messages: ['а'.repeat(4001)] })).statusCode).toBe(400);
  });

  it('lists every case for the agent', async () => {
    await post({ title: 'Первый', messages: ['раз'] });
    await post({ title: 'Второй', messages: ['два'] });

    const res = await app.inject({ method: 'GET', cookies: jar, url: cases() });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(2);
  });

  it('switches a case off without deleting it', async () => {
    const kase = (await post({ title: 'Про скидку', messages: ['дадите скидку?'] })).json();

    const res = await app.inject({
      method: 'PATCH',
      url: `${cases()}/${kase.id}`,
      cookies: jar,
      payload: { enabled: false },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().enabled).toBe(false);
    expect(await db.select().from(testCases)).toHaveLength(1);
  });

  it('deletes a case outright', async () => {
    const kase = (await post({ title: 'Про скидку', messages: ['дадите скидку?'] })).json();

    const res = await app.inject({ method: 'DELETE', url: `${cases()}/${kase.id}`, cookies: jar });

    expect(res.statusCode).toBe(200);
    expect(await db.select().from(testCases)).toHaveLength(0);
  });

  // `baselineResults` (`lib/drafts/baseline.ts`) keys «было» on the case, the agent's
  // `config_version` and its model — nothing about a case's own `updated_at`. Left alone, a
  // changed question would still pair against the old question's «было»: a run would compare
  // an answer to a *different* question and pay a model to write a verdict about the mismatch.
  // Chosen fix: delete the case's own baseline rows the moment `messages` changes, so the next
  // run pays for a fresh one instead of reusing a stale one — see `api/test-cases.ts`'s own
  // comment on the PATCH route for why this, rather than teaching `baselineResults` to read
  // `updated_at`.
  it('drops a case\'s own baseline results when its messages change', async () => {
    const kase = (await post({ title: 'Про доставку', messages: ['сколько стоит доставка?'] })).json();

    const [baselineRun] = await db
      .insert(testRuns)
      .values({ agentId, draftId: null, configVersion: 1, model: 'x', status: 'done' })
      .returning();
    await db.insert(testResults).values({ runId: baselineRun!.id, caseId: kase.id, outcome: 'sent' });

    const res = await app.inject({
      method: 'PATCH',
      url: `${cases()}/${kase.id}`,
      cookies: jar,
      payload: { messages: ['а в область доставите?'] },
    });
    expect(res.statusCode).toBe(200);

    const remaining = await db.select().from(testResults).where(eq(testResults.caseId, kase.id));
    expect(remaining).toHaveLength(0);
  });

  it('leaves a case\'s baseline alone when only its title or expectation changes', async () => {
    const kase = (await post({ title: 'Про доставку', messages: ['сколько стоит доставка?'] })).json();

    const [baselineRun] = await db
      .insert(testRuns)
      .values({ agentId, draftId: null, configVersion: 1, model: 'x', status: 'done' })
      .returning();
    await db.insert(testResults).values({ runId: baselineRun!.id, caseId: kase.id, outcome: 'sent' });

    const res = await app.inject({
      method: 'PATCH',
      url: `${cases()}/${kase.id}`,
      cookies: jar,
      payload: { title: 'Доставка (новое название)' },
    });
    expect(res.statusCode).toBe(200);

    const remaining = await db.select().from(testResults).where(eq(testResults.caseId, kase.id));
    expect(remaining).toHaveLength(1);
  });

  // A draft's own «стало» rows are never anyone's baseline (`baselineResults` only ever reads
  // `draft_id is null`), so a messages edit must leave them alone even for the very case whose
  // real baseline it just cleared.
  it("does not touch a draft run's own results when messages change", async () => {
    const kase = (await post({ title: 'Про доставку', messages: ['сколько стоит доставка?'] })).json();
    const [draft] = await db
      .insert(kbDrafts)
      .values({ agentId, title: 'Черновик', origin: 'manual', status: 'open', ops: [], base: {} })
      .returning();
    const [draftRun] = await db
      .insert(testRuns)
      .values({ agentId, draftId: draft!.id, configVersion: 1, model: 'x', status: 'done' })
      .returning();
    await db.insert(testResults).values({ runId: draftRun!.id, caseId: kase.id, outcome: 'sent' });

    const res = await app.inject({
      method: 'PATCH',
      url: `${cases()}/${kase.id}`,
      cookies: jar,
      payload: { messages: ['а в область доставите?'] },
    });
    expect(res.statusCode).toBe(200);

    const remaining = await db.select().from(testResults).where(eq(testResults.caseId, kase.id));
    expect(remaining).toHaveLength(1);
  });

  it('refuses a member on every write route, and on the read', async () => {
    const kase = (await post({ title: 'Про скидку', messages: ['дадите скидку?'] })).json();

    expect((await app.inject({ method: 'GET', url: cases(), cookies: memberJar })).statusCode).toBe(403);
    expect(
      (await app.inject({ method: 'POST', url: cases(), cookies: memberJar, payload: { title: 'x', messages: ['x'] } }))
        .statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: 'PATCH', url: `${cases()}/${kase.id}`, cookies: memberJar, payload: { enabled: false } }))
        .statusCode,
    ).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: `${cases()}/${kase.id}`, cookies: memberJar })).statusCode).toBe(403);
  });
});

describe('pulling a case out of a real dialog', () => {
  it('pulls the customer side out of a dialog and nothing else', async () => {
    const { conversationId } = await dialogWith([
      { author: 'client', body: 'здравствуйте' },
      { author: 'agent', body: 'Здравствуйте! Какие двери нужны?' },
      { author: 'client', body: 'входные' },
    ]);

    const res = await app.inject({
      method: 'POST',
      cookies: jar,
      url: `${cases()}/from-dialog`,
      payload: { conversationId },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().messages).toEqual(['здравствуйте', 'входные']);
    expect(res.json().origin).toBe('dialog');
    expect(res.json().conversationId).toBe(conversationId);
  });

  it('takes at most ten messages out of a long dialog', async () => {
    const { conversationId } = await dialogWith(
      Array.from({ length: 14 }, (_, i) => ({ author: 'client' as const, body: `реплика ${i}` })),
    );

    const res = await app.inject({
      method: 'POST',
      cookies: jar,
      url: `${cases()}/from-dialog`,
      payload: { conversationId },
    });

    expect(res.json().messages).toHaveLength(10);
    expect(res.json().messages[9]).toBe('реплика 13');
    expect(res.json().messages[0]).toBe('реплика 4');
  });

  it('refuses a dialog with no client messages', async () => {
    const { conversationId } = await dialogWith([{ author: 'agent', body: 'Здравствуйте!' }]);

    const res = await app.inject({
      method: 'POST',
      cookies: jar,
      url: `${cases()}/from-dialog`,
      payload: { conversationId },
    });

    expect(res.statusCode).toBe(400);
  });

  it('refuses a conversation that does not belong to this agent', async () => {
    const res = await app.inject({
      method: 'POST',
      cookies: jar,
      url: `${cases()}/from-dialog`,
      payload: { conversationId: randomUUID() },
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('suggesting cases from a draft', () => {
  it('suggests cases without saving any of them', async () => {
    model.reply({ cases: [{ title: 'Доставка в Астану', messages: ['везёте в Астану?'] }] });
    const draft = await openDraft();

    const res = await app.inject({
      method: 'POST',
      cookies: jar,
      url: `${drafts()}/${draft.id}/suggest-cases`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().cases).toHaveLength(1);
    expect(res.json().cases[0]).toEqual({ title: 'Доставка в Астану', messages: ['везёте в Астану?'] });
    expect(await db.select().from(testCases)).toEqual([]);
  });

  it('refuses a member', async () => {
    model.reply({ cases: [{ title: 'x', messages: ['x'] }] });
    const draft = await openDraft();

    const res = await app.inject({
      method: 'POST',
      cookies: memberJar,
      url: `${drafts()}/${draft.id}/suggest-cases`,
    });

    expect(res.statusCode).toBe(403);
  });

  it('refuses a draft that does not exist', async () => {
    const res = await app.inject({
      method: 'POST',
      cookies: jar,
      url: `${drafts()}/${randomUUID()}/suggest-cases`,
    });

    expect(res.statusCode).toBe(404);
  });
});
