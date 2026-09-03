/**
 * Во что обошлись ответы агента — то, что делает выбор модели сравнимым с ценой.
 *
 * The rows are written straight into `ai_replies` rather than produced by running turns: what
 * is under test is the arithmetic and the tenancy of one read route, and a turn per row would
 * make the fixture about the turn instead. That the log is written correctly is
 * `ai-inbound.test.ts`'s job, and it stays there.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import type { Db } from '../src/db/client.js';
import {
  agents,
  aiReplies,
  contacts,
  conversations,
  whatsappNumbers,
} from '../src/db/schema.js';
import { addMember, createAccountWithOwner } from '../src/lib/provision.js';
import { encryptSecret } from '../src/lib/secret-box.js';
import { withDb } from './helpers/db.js';
import { testEnv } from './helpers/env.js';
import { fakeGraph } from './helpers/fake-graph.js';

const env = testEnv();
const key = Buffer.from(env.CREDENTIALS_KEY, 'base64');
const PASSWORD = 'correct-horse-battery';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const CHEAP = 'openai/gpt-4o-mini';
const DEAR = 'anthropic/claude-sonnet-4.5';

let db: Db;
let app: FastifyInstance;
let agentId: string;
let conversationId: string;
let jar: Record<string, string>;

async function login(email = 'owner@example.com') {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: PASSWORD },
  });
  const cookie = res.cookies[0]!;
  return { [cookie.name]: cookie.value };
}

/** A company with an agent, a number and one conversation for the log to hang off. */
async function seedAgent(company: string, email: string): Promise<{ agentId: string; conversationId: string }> {
  const { accountId } = await createAccountWithOwner(db, {
    company,
    email,
    name: 'Владелец',
    initials: 'ВЛ',
    password: PASSWORD,
  });
  const [agent] = await db.insert(agents).values({ accountId, name: company }).returning();
  const suffix = randomUUID().slice(0, 8);
  const [number] = await db
    .insert(whatsappNumbers)
    .values({
      agentId: agent!.id,
      phoneNumberId: `pnid-${suffix}`,
      wabaId: `waba-${suffix}`,
      displayPhone: '+7 708 580 79 32',
      accessToken: encryptSecret('EAAG-token', key, `pnid-${suffix}`),
    })
    .returning();
  const [contact] = await db
    .insert(contacts)
    .values({ agentId: agent!.id, phone: `7777${suffix}` })
    .returning();
  const [conversation] = await db
    .insert(conversations)
    .values({
      agentId: agent!.id,
      contactId: contact!.id,
      whatsappNumberId: number!.id,
    })
    .returning();
  return { agentId: agent!.id, conversationId: conversation!.id };
}

interface Turn {
  model?: string;
  outcome?: string;
  promptTokens?: number;
  completionTokens?: number;
  cost?: string;
  /** How long ago it ran. Everything defaults to an hour back, inside every period. */
  ago?: number;
  onAgent?: string;
  inConversation?: string;
}

const logTurn = (turn: Turn = {}) =>
  db.insert(aiReplies).values({
    agentId: turn.onAgent ?? agentId,
    conversationId: turn.inConversation ?? conversationId,
    model: turn.model ?? CHEAP,
    outcome: turn.outcome ?? 'sent',
    promptTokens: turn.promptTokens ?? 0,
    completionTokens: turn.completionTokens ?? 0,
    cost: turn.cost ?? '0',
    createdAt: new Date(Date.now() - (turn.ago ?? HOUR)),
  });

const usage = (period?: string, cookies = jar) =>
  app.inject({
    method: 'GET',
    url: `/api/agents/${agentId}/ai/usage${period === undefined ? '' : `?period=${period}`}`,
    cookies,
  });

beforeEach(async () => {
  db = await withDb();
  ({ agentId, conversationId } = await seedAgent('Сафина', 'owner@example.com'));
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
  jar = await login();
});

afterEach(async () => {
  await app.close();
});

describe('what the agent has spent', () => {
  it('counts the turns, the outcomes, the tokens and the money', async () => {
    await logTurn({ outcome: 'sent', promptTokens: 1200, completionTokens: 80, cost: '0.00012300' });
    await logTurn({ outcome: 'sent', promptTokens: 900, completionTokens: 40, cost: '0.00009100' });
    await logTurn({ outcome: 'handoff', promptTokens: 1000, completionTokens: 30, cost: '0.00010000' });
    await logTurn({ outcome: 'failed', promptTokens: 0, completionTokens: 0, cost: '0' });
    await logTurn({ outcome: 'skipped', promptTokens: 500, completionTokens: 10, cost: '0.00005000' });

    const res = await usage('week');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      period: 'week',
      total: {
        turns: 5,
        sent: 2,
        handoff: 1,
        failed: 1,
        promptTokens: 3600,
        completionTokens: 160,
        // Added by Postgres and read back as text: a fraction of a cent per turn survives
        // the trip only because nothing on the way turned it into a float.
        cost: '0.00036400',
      },
    });
  });

  it('says the period it counted from', async () => {
    await logTurn();
    const res = await usage('day');
    const body = res.json();
    expect(body.period).toBe('day');
    const since = new Date(body.since).getTime();
    // A day back, give or take the seconds the request took.
    expect(Math.abs(since - (Date.now() - DAY))).toBeLessThan(60_000);
  });

  it('counts only turns inside the period', async () => {
    await logTurn({ ago: 2 * HOUR, cost: '0.00001000' });
    await logTurn({ ago: 3 * DAY, cost: '0.00002000' });
    await logTurn({ ago: 40 * DAY, cost: '0.00004000' });

    expect((await usage('day')).json().total).toMatchObject({ turns: 1, cost: '0.00001000' });
    expect((await usage('week')).json().total).toMatchObject({ turns: 2, cost: '0.00003000' });
    expect((await usage('month')).json().total).toMatchObject({ turns: 2, cost: '0.00003000' });
  });

  it('never counts another agent’s turns', async () => {
    const stranger = await seedAgent('Другая компания', 'stranger@example.com');
    await logTurn({ cost: '0.00001000' });
    await logTurn({
      onAgent: stranger.agentId,
      inConversation: stranger.conversationId,
      model: DEAR,
      promptTokens: 90_000,
      completionTokens: 9_000,
      cost: '9.99000000',
    });

    const body = (await usage('month')).json();
    expect(body.total).toMatchObject({ turns: 1, promptTokens: 0, cost: '0.00001000' });
    expect(body.byModel).toHaveLength(1);
    expect(body.byModel[0].model).toBe(CHEAP);
  });

  it('answers empty rather than zeros when nothing ran in the period', async () => {
    // Turns exist — they are just older than the period asked about, which is exactly the
    // case where a row of zeros would read as a fact about the model.
    await logTurn({ ago: 10 * DAY, cost: '1.00000000' });

    const body = (await usage('day')).json();
    expect(body.total).toBeNull();
    expect(body.byModel).toEqual([]);
  });

  it('answers empty for an agent that has never answered anybody', async () => {
    const body = (await usage('month')).json();
    expect(body.total).toBeNull();
    expect(body.byModel).toEqual([]);
  });

  it('groups by model when the owner switched models mid-period', async () => {
    await logTurn({ model: CHEAP, ago: 6 * DAY, promptTokens: 1000, completionTokens: 50, cost: '0.00010000' });
    await logTurn({ model: CHEAP, ago: 5 * DAY, promptTokens: 1000, completionTokens: 50, cost: '0.00010000' });
    await logTurn({ model: CHEAP, ago: 4 * DAY, outcome: 'handoff', promptTokens: 1000, completionTokens: 50, cost: '0.00010000' });
    await logTurn({ model: DEAR, ago: 2 * DAY, promptTokens: 1100, completionTokens: 60, cost: '0.01500000' });
    await logTurn({ model: DEAR, ago: 1 * DAY, outcome: 'failed', promptTokens: 0, completionTokens: 0, cost: '0' });

    const body = (await usage('month')).json();
    expect(body.total).toMatchObject({
      turns: 5,
      sent: 3,
      handoff: 1,
      failed: 1,
      promptTokens: 4100,
      completionTokens: 210,
      cost: '0.01530000',
    });
    // Busiest first, so the model the owner is on now is not buried under the one they left.
    expect(body.byModel).toEqual([
      {
        model: CHEAP,
        turns: 3,
        sent: 2,
        handoff: 1,
        failed: 0,
        promptTokens: 3000,
        completionTokens: 150,
        cost: '0.00030000',
      },
      {
        model: DEAR,
        turns: 2,
        sent: 1,
        handoff: 0,
        failed: 1,
        promptTokens: 1100,
        completionTokens: 60,
        cost: '0.01500000',
      },
    ]);
  });

  it('defaults to the week when no period is asked for', async () => {
    await logTurn({ ago: 3 * DAY });
    await logTurn({ ago: 20 * DAY });

    const body = (await usage()).json();
    expect(body.period).toBe('week');
    expect(body.total).toMatchObject({ turns: 1 });
  });

  it('refuses a period it does not know', async () => {
    const res = await usage('year');
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('Неизвестный период');
  });

  it('is readable by any member, not only the owner', async () => {
    await logTurn({ cost: '0.00007000' });
    const res = await usage('week', await login('member@example.com'));
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toMatchObject({ turns: 1, cost: '0.00007000' });
  });

  it('refuses a stranger’s agent', async () => {
    const stranger = await seedAgent('Третья компания', 'third@example.com');
    const res = await app.inject({
      method: 'GET',
      url: `/api/agents/${stranger.agentId}/ai/usage?period=week`,
      cookies: jar,
    });
    expect(res.statusCode).toBe(404);
  });
});
