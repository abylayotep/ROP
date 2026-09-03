/**
 * Где сейчас стоят лиды — снимок, у которого нет периода.
 *
 * The conversations are inserted straight into the table rather than produced by moving
 * leads through the board: what is under test is one read route's arithmetic and its
 * tenancy, and a stage move per row would make the fixture about the move instead. That a
 * move lands where it should is `stages-api.test.ts`'s job, and it stays there.
 */
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
  stages,
  whatsappNumbers,
} from '../src/db/schema.js';
import { encryptSecret } from '../src/lib/secret-box.js';
import { addMember, createAccountWithOwner } from '../src/lib/provision.js';
import { withDb } from './helpers/db.js';
import { testEnv } from './helpers/env.js';
import { fakeGraph } from './helpers/fake-graph.js';

const env = testEnv();
const key = Buffer.from(env.CREDENTIALS_KEY, 'base64');
const PASSWORD = 'correct-horse-battery';

let db: Db;
let app: FastifyInstance;
let agentId: string;
let numberId: string;
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

/**
 * A company with an agent and a number, and a funnel written here rather than seeded.
 *
 * Three stages in a deliberately scrambled insertion order: `position` is what the route
 * promises to sort by, and a fixture inserted already in order would pass even if the
 * route sorted by nothing at all.
 */
async function seedAgent(
  company: string,
  email: string,
): Promise<{ agentId: string; numberId: string; stageIds: string[] }> {
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

  await db.insert(stages).values([
    { agentId: agent!.id, name: 'Продажа', color: '#0d9668', kind: 'success', position: 2 },
    { agentId: agent!.id, name: 'Новый лид', color: '#8a94a6', kind: 'active', position: 0 },
    { agentId: agent!.id, name: 'В диалоге', color: '#4b8ef0', kind: 'active', position: 1 },
  ]);
  const funnel = await db.select().from(stages).where(eq(stages.agentId, agent!.id));
  const ordered = [...funnel].sort((a, b) => a.position - b.position);

  return {
    agentId: agent!.id,
    numberId: number!.id,
    stageIds: ordered.map((stage) => stage.id),
  };
}

/** One conversation on the agent's number, standing where the caller says. */
async function addLead(stageId: string | null, onAgent = agentId, onNumber = numberId) {
  const [contact] = await db
    .insert(contacts)
    .values({ agentId: onAgent, phone: `7777${randomUUID().slice(0, 8)}` })
    .returning();
  await db.insert(conversations).values({
    agentId: onAgent,
    contactId: contact!.id,
    whatsappNumberId: onNumber,
    stageId,
  });
}

const current = (id = agentId, cookies = jar) =>
  app.inject({ method: 'GET', url: `/api/agents/${id}/stats/current`, cookies });

let stageIds: string[];

beforeEach(async () => {
  db = await withDb();
  ({ agentId, numberId, stageIds } = await seedAgent('Сафина', 'owner@example.com'));
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

describe('where the leads stand now', () => {
  it('lists every stage in position order, including the empty ones', async () => {
    await addLead(stageIds[0]!);
    await addLead(stageIds[2]!);
    await addLead(stageIds[2]!);

    const res = await current();
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.stages.map((stage: { name: string }) => stage.name)).toEqual([
      'Новый лид',
      'В диалоге',
      'Продажа',
    ]);
    // The middle stage holds nobody and is still here: a stage missing from the list
    // reads as a stage that does not exist.
    expect(body.stages.map((stage: { leads: number }) => stage.leads)).toEqual([1, 0, 2]);
    expect(body.stages[1]).toMatchObject({
      stageId: stageIds[1],
      color: '#4b8ef0',
      kind: 'active',
      position: 1,
    });
  });

  it('puts a lead nobody triaged in unsorted and in no stage', async () => {
    await addLead(null);
    await addLead(null);
    await addLead(stageIds[0]!);

    const body = (await current()).json();
    expect(body.unsorted).toBe(2);
    expect(body.stages.map((stage: { leads: number }) => stage.leads)).toEqual([1, 0, 0]);
  });

  it('totals the stages plus unsorted, and nothing else', async () => {
    await addLead(null);
    await addLead(stageIds[0]!);
    await addLead(stageIds[1]!);
    await addLead(stageIds[2]!);

    const body = (await current()).json();
    const summed =
      body.stages.reduce((sum: number, stage: { leads: number }) => sum + stage.leads, 0) +
      body.unsorted;
    expect(body.total).toBe(4);
    expect(body.total).toBe(summed);
  });

  it('counts an agent with no conversations at zero rather than answering nothing', async () => {
    const body = (await current()).json();
    expect(body.stages.map((stage: { leads: number }) => stage.leads)).toEqual([0, 0, 0]);
    expect(body.unsorted).toBe(0);
    expect(body.total).toBe(0);
  });

  it('names when the cabinet began recording stage movement', async () => {
    const body = (await current()).json();
    expect(typeof body.stageHistorySince).toBe('string');
    expect(Number.isNaN(Date.parse(body.stageHistorySince))).toBe(false);
  });

  it('counts only this agent, not another account with leads of its own', async () => {
    const other = await seedAgent('Тандем', 'stranger@example.com');
    await addLead(other.stageIds[0]!, other.agentId, other.numberId);
    await addLead(null, other.agentId, other.numberId);
    await addLead(stageIds[0]!);

    const body = (await current()).json();
    expect(body.total).toBe(1);
    expect(body.unsorted).toBe(0);
  });

  it('answers 404 for another account’s agent, and for a malformed id', async () => {
    const other = await seedAgent('Тандем', 'stranger@example.com');

    // 404 and not 403: a 403 would confirm the agent exists to someone with no business
    // knowing that.
    expect((await current(other.agentId)).statusCode).toBe(404);
    expect((await current('не-uuid')).statusCode).toBe(404);
  });

  it('answers a member, not the owner only', async () => {
    await addLead(stageIds[0]!);
    const memberJar = await login('member@example.com');

    const res = await current(agentId, memberJar);
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(1);
  });
});
