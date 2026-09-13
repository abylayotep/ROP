/**
 * The autopilot routes: start, read, cancel, and the 409 the manual draft routes answer while an
 * autopilot drives the draft. The engine itself is `draft-autopilot.test.ts`'s subject; here a
 * started autopilot is given nothing it could spend money on.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import type { Db } from '../src/db/client.js';
import { agents, draftAutopilots, kbDrafts, testCases } from '../src/db/schema.js';
import { keyAad } from '../src/lib/ai/turn.js';
import type { DraftOp } from '../src/lib/drafts/ops.js';
import { createAccountWithOwner } from '../src/lib/provision.js';
import { encryptSecret } from '../src/lib/secret-box.js';
import { withDb } from './helpers/db.js';
import { testEnv } from './helpers/env.js';
import { fakeGraph } from './helpers/fake-graph.js';
import { fakeModel } from './helpers/fake-model.js';

const env = testEnv();
const key = Buffer.from(env.CREDENTIALS_KEY, 'base64');
const PASSWORD = 'correct-horse-battery';
const BLOCKED = 'Черновик проверяется автоматически — остановите проверку, чтобы менять его вручную';

let app: FastifyInstance;
let db: Db;
let agentId: string;
let userId: string;
let jar: Record<string, string>;

async function openDraft(ops: DraftOp[]) {
  const [row] = await db
    .insert(kbDrafts)
    .values({ agentId, title: 'Черновик', origin: 'manual', status: 'open', ops, base: {} })
    .returning();
  return row!;
}

// A rule-only draft with no cases stops on its first step without a single model call.
const RULE_ONLY: DraftOp[] = [{ op: 'rule_create', category: 'forbid', text: 'Не обещай скидку.' }];

const url = (draftId: string, tail = '') => `/api/agents/${agentId}/drafts/${draftId}${tail}`;

function start(draftId: string, caseIds: string[] = []) {
  return app.inject({ method: 'POST', cookies: jar, url: url(draftId, '/autopilot'), payload: { caseIds } });
}

async function runningRow(draftId: string) {
  const [row] = await db
    .insert(draftAutopilots)
    .values({ agentId, draftId, createdBy: userId, status: 'running', step: 'await_run' })
    .returning();
  return row!;
}

async function waitUntilSettled(id: string) {
  for (let tries = 0; tries < 300; tries += 1) {
    const [row] = await db.select().from(draftAutopilots).where(eq(draftAutopilots.id, id));
    if (row && row.status !== 'running') return row;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the autopilot never left `running`');
}

beforeEach(async () => {
  db = await withDb();
  const owner = await createAccountWithOwner(db, {
    company: 'Сафина',
    email: 'owner@example.com',
    name: 'Владелец',
    initials: 'ВЛ',
    password: PASSWORD,
  });
  userId = owner.userId;
  agentId = randomUUID();
  await db.insert(agents).values({
    id: agentId,
    accountId: owner.accountId,
    name: 'Сафина',
    openrouterKey: encryptSecret('sk-or-v1-autopilot-api', key, keyAad(agentId)),
  });
  app = buildServer(env, db, { graph: fakeGraph(), model: fakeModel() });
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

describe('POST …/autopilot', () => {
  it('creates a running autopilot at prepare_cases and kicks its first step', async () => {
    const draft = await openDraft(RULE_ONLY);
    const res = await start(draft.id);

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      status: 'running',
      step: 'prepare_cases',
      runsStarted: 0,
      maxRuns: 4,
      runId: null,
      caseIds: [],
      log: [],
      stopReason: null,
      finishedAt: null,
    });

    // The first step ran without waiting for a drain timer.
    const settled = await waitUntilSettled(body.id);
    expect(settled).toMatchObject({ status: 'stopped', stopReason: 'Не из чего собрать проверки' });
  });

  it('refuses a second autopilot on the same draft', async () => {
    const draft = await openDraft(RULE_ONLY);
    await runningRow(draft.id);
    const res = await start(draft.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toBe('Черновик уже проверяется автоматически');
  });

  it('refuses without an OpenRouter key', async () => {
    const draft = await openDraft(RULE_ONLY);
    await db.update(agents).set({ openrouterKey: null }).where(eq(agents.id, agentId));
    const res = await start(draft.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toBe('Нет ключа OpenRouter');
    expect(await db.select().from(draftAutopilots)).toHaveLength(0);
  });

  it('refuses a draft that is not open and a malformed case id', async () => {
    const draft = await openDraft(RULE_ONLY);
    const bad = await start(draft.id, ['not-a-uuid']);
    expect(bad.statusCode).toBe(404);
    expect(bad.json().message).toBe('Случай не найден');

    await db.update(kbDrafts).set({ status: 'applied' }).where(eq(kbDrafts.id, draft.id));
    const closed = await start(draft.id);
    expect(closed.statusCode).toBe(409);
    expect(closed.json().message).toBe('Черновик уже применён или отклонён');
    expect(await db.select().from(draftAutopilots)).toHaveLength(0);
  });

  it('keeps the owner’s case ids on the row', async () => {
    const draft = await openDraft(RULE_ONLY);
    const [kase] = await db
      .insert(testCases)
      .values({ agentId, title: 'Вопрос', messages: ['Вопрос'], origin: 'manual', enabled: false })
      .returning();
    const res = await start(draft.id, [kase!.id, kase!.id]);
    expect(res.json().caseIds).toEqual([kase!.id]);
    await waitUntilSettled(res.json().id);
  });
});

describe('GET …/autopilot', () => {
  it('answers the newest autopilot of the draft, or null', async () => {
    const draft = await openDraft(RULE_ONLY);
    const none = await app.inject({ method: 'GET', cookies: jar, url: url(draft.id, '/autopilot') });
    expect(none.statusCode).toBe(200);
    expect(none.json()).toBeNull();

    await db.insert(draftAutopilots).values({
      agentId, draftId: draft.id, createdBy: userId, status: 'stopped', step: 'start_run',
      createdAt: new Date(Date.now() - 60_000),
    });
    const newest = await runningRow(draft.id);
    const res = await app.inject({ method: 'GET', cookies: jar, url: url(draft.id, '/autopilot') });
    expect(res.json()).toMatchObject({ id: newest.id, status: 'running', step: 'await_run' });
  });
});

describe('POST …/autopilot/cancel', () => {
  it('cancels the running autopilot', async () => {
    const draft = await openDraft(RULE_ONLY);
    const row = await runningRow(draft.id);
    const res = await app.inject({ method: 'POST', cookies: jar, url: url(draft.id, '/autopilot/cancel') });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: row.id, status: 'cancelled' });
    expect(res.json().finishedAt).not.toBeNull();
    const [stored] = await db.select().from(draftAutopilots).where(eq(draftAutopilots.id, row.id));
    expect(stored!.status).toBe('cancelled');

    const again = await app.inject({ method: 'POST', cookies: jar, url: url(draft.id, '/autopilot/cancel') });
    expect(again.json()).toMatchObject({ id: row.id, status: 'cancelled' });
  });
});

describe('manual routes while an autopilot runs', () => {
  it('answer 409 on run, apply, discard and op edit', async () => {
    const draft = await openDraft(RULE_ONLY);
    await runningRow(draft.id);
    const calls = [
      { tail: '/runs', payload: { caseIds: [] } },
      { tail: '/apply', payload: {} },
      { tail: '/discard', payload: {} },
      { tail: '/ops', payload: { action: 'remove', index: 0, current: RULE_ONLY[0] } },
    ];
    for (const call of calls) {
      const res = await app.inject({ method: 'POST', cookies: jar, url: url(draft.id, call.tail), payload: call.payload });
      expect(res.statusCode, call.tail).toBe(409);
      expect(res.json().message, call.tail).toBe(BLOCKED);
    }
    const [stored] = await db.select().from(kbDrafts).where(eq(kbDrafts.id, draft.id));
    expect(stored!.status).toBe('open');
  });
});
