/**
 * Каждый переход по воронке записывается — и только настоящий.
 *
 * Two writers move `conversations.stage_id` and they are copies of one another: the
 * operator's PATCH in `api/leads.ts` and the agent's own move in `lib/ai/turn.ts`. This
 * suite drives both through their real entry points rather than calling `recordStageMove`
 * directly, because what is under test is not the insert — it is the four places a row
 * must *not* appear: a lost race, a move to the stage the lead already stands in, a patch
 * that touches only the assignee, and the sandbox.
 *
 * A hole here is permanent. `stage_transitions` cannot be backfilled from anything, so a
 * move that goes unrecorded is a lead the funnel will never know about.
 */
import { randomUUID } from 'node:crypto';
import { asc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import type { Db } from '../src/db/client.js';
import {
  agents,
  contacts,
  conversations,
  messages,
  stages,
  stageTransitions,
  users,
  whatsappNumbers,
} from '../src/db/schema.js';
import { runTurn, type TurnDeps } from '../src/lib/ai/turn.js';
import { seedFunnel } from '../src/lib/funnel.js';
import { createAccountWithOwner } from '../src/lib/provision.js';
import { encryptSecret } from '../src/lib/secret-box.js';
import { withDb } from './helpers/db.js';
import { testEnv } from './helpers/env.js';
import { fakeGraph, type FakeGraph } from './helpers/fake-graph.js';
import { fakeModel } from './helpers/fake-model.js';
import { fakeLinked } from './helpers/fake-linked.js';

/** No test opens a socket: a linked number never appears in these fixtures. */
const linked = fakeLinked();

const env = testEnv();
const key = Buffer.from(env.CREDENTIALS_KEY, 'base64');
const PASSWORD = 'correct-horse-battery';
const OPENROUTER_KEY = 'sk-or-v1-0123456789abcdef';

let db: Db;
let app: FastifyInstance;
let graph: FakeGraph;
let agentId: string;
let conversationId: string;
let ownerId: string;
let jar: Record<string, string>;

/** The five keys a model is asked for, with only the ones a test cares about overridden. */
const answer = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    reply: 'Здравствуйте! Чем помочь?',
    stageId: null,
    fields: {},
    handoff: null,
    usedItemIds: [],
    ...over,
  });

const deps = (): TurnDeps => ({ model: fakeModel(answer()), graph, linked, key });

const turn = (stageId: string | null, options: { dryRun?: boolean } = {}) =>
  runTurn(
    db,
    { model: fakeModel(answer({ stageId, reply: 'Уточняю детали.' })), graph, linked, key },
    { agentId, conversationId, ...options },
  );

const leadUrl = () => `/api/agents/${agentId}/conversations/${conversationId}/lead`;

const patch = (payload: Record<string, unknown>) =>
  app.inject({ method: 'PATCH', url: leadUrl(), cookies: jar, payload });

const stageNamed = async (name: string) => {
  const rows = await db.select().from(stages).where(eq(stages.agentId, agentId));
  return rows.find((row) => row.name === name)!;
};

/** Every transition of the fixture's agent, oldest first. */
const transitions = () =>
  db
    .select()
    .from(stageTransitions)
    .where(eq(stageTransitions.agentId, agentId))
    .orderBy(asc(stageTransitions.occurredAt));

beforeEach(async () => {
  db = await withDb();
  const { accountId } = await createAccountWithOwner(db, {
    company: 'Сафина',
    email: 'owner@example.com',
    name: 'Владелец',
    initials: 'ВЛ',
    password: PASSWORD,
  });
  [ownerId] = (await db.select({ id: users.id }).from(users)).map((row) => row.id) as [string];

  // Minted here rather than read back: the OpenRouter key is sealed against the agent id,
  // so the row has to carry the sealed value from the moment it is written.
  agentId = randomUUID();
  await db.insert(agents).values({
    id: agentId,
    accountId,
    name: 'Сафина',
    aiEnabled: true,
    openrouterKey: encryptSecret(OPENROUTER_KEY, key, agentId),
  });
  await seedFunnel(db, agentId);

  const [number] = await db
    .insert(whatsappNumbers)
    .values({
      agentId,
      phoneNumberId: '136',
      wabaId: 'waba',
      displayPhone: '+7 708 580 79 32',
      accessToken: encryptSecret('EAAG-token', key, '136'),
    })
    .returning();
  const [contact] = await db
    .insert(contacts)
    .values({ agentId, phone: '77085807932', name: 'Айгуль' })
    .returning();
  const [conversation] = await db
    .insert(conversations)
    .values({
      agentId,
      contactId: contact!.id,
      whatsappNumberId: number!.id,
      lastInboundAt: new Date(Date.now() - 60_000),
      lastMessageAt: new Date(Date.now() - 60_000),
    })
    .returning();
  conversationId = conversation!.id;
  await db.insert(messages).values({
    conversationId,
    direction: 'in',
    author: 'client',
    kind: 'text',
    body: 'Сколько стоит доставка?',
    sentAt: new Date(Date.now() - 60_000),
  });

  graph = fakeGraph();
  app = buildServer(env, db, { graph });
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

describe('the operator moves a lead', () => {
  it('writes one row with both stages snapshotted and who made the move', async () => {
    const first = await stageNamed('Новый лид');
    const second = await stageNamed('В диалоге');
    await patch({ stageId: first.id });
    await patch({ stageId: second.id });

    const rows = await transitions();
    expect(rows).toHaveLength(2);
    const move = rows.find((row) => row.toStageId === second.id)!;
    expect(move.conversationId).toBe(conversationId);
    expect(move.fromStageId).toBe(first.id);
    expect(move.fromName).toBe('Новый лид');
    expect(move.fromPosition).toBe(first.position);
    expect(move.toStageId).toBe(second.id);
    expect(move.toName).toBe('В диалоге');
    expect(move.toKind).toBe('active');
    expect(move.toPosition).toBe(second.position);
    expect(move.movedBy).toBe('operator');
    expect(move.movedByUserId).toBe(ownerId);
    expect(move.occurredAt).not.toBeNull();
  });

  it('records the first stage with no stage behind it', async () => {
    const first = await stageNamed('Новый лид');

    await patch({ stageId: first.id });

    const rows = await transitions();
    expect(rows).toHaveLength(1);
    // Null, not a placeholder: the lead came from nowhere, and this row is what gives the
    // funnel's first column a denominator.
    expect(rows[0]!.fromStageId).toBeNull();
    expect(rows[0]!.fromName).toBeNull();
    expect(rows[0]!.fromPosition).toBeNull();
    expect(rows[0]!.toStageId).toBe(first.id);
  });

  it('records a move backwards like any other', async () => {
    const later = await stageNamed('Заказано');
    const earlier = await stageNamed('В диалоге');
    await patch({ stageId: later.id });

    await patch({ stageId: earlier.id });

    const rows = await transitions();
    expect(rows).toHaveLength(2);
    // Nothing rejects it and nothing hides it. How often a funnel runs backwards is worth
    // knowing, and the report counts it from these two positions.
    const back = rows.find((row) => row.toStageId === earlier.id)!;
    expect(back.fromPosition).toBe(later.position);
    expect(back.toPosition).toBe(earlier.position);
    expect(back.toPosition).toBeLessThan(back.fromPosition!);
  });

  it('writes nothing when the lead is already in the stage named', async () => {
    const first = await stageNamed('Новый лид');
    await patch({ stageId: first.id });

    await patch({ stageId: first.id });

    expect(await transitions()).toHaveLength(1);
  });

  it('writes nothing when only the assignee changes', async () => {
    const members = (
      await app.inject({ url: `/api/agents/${agentId}/members`, cookies: jar })
    ).json() as { id: string; name: string }[];

    await patch({ assignedTo: members[0]!.id });

    expect(await transitions()).toHaveLength(0);
  });

  it('writes nothing when the lead is taken out of the funnel', async () => {
    const first = await stageNamed('Новый лид');
    await patch({ stageId: first.id });

    await patch({ stageId: null });

    // A lead cleared out of the funnel has not entered a stage, and there is no stage for
    // the report to count it into. The move is still visible on the lead card, which is
    // what `stage_set_at` is for.
    expect(await transitions()).toHaveLength(1);
    expect((await db.select().from(conversations))[0]!.stageId).toBeNull();
  });

  it('writes one row between two requests that read the same stage', async () => {
    const first = await stageNamed('Новый лид');
    const mine = await stageNamed('В диалоге');
    const theirs = await stageNamed('Квалифицирован');
    await patch({ stageId: first.id });

    // The forced race `leads-api.test.ts` already uses: a second writer holds the row, the
    // request reads the old stage and blocks on its own write, and the lead is moved out
    // from under it. The guarded UPDATE then touches nothing — and a transition written
    // anyway would be this request claiming a move somebody else made.
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const other = db.transaction(async (tx) => {
      await tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .for('update');
      await held;
      await tx
        .update(conversations)
        .set({ stageId: theirs.id })
        .where(eq(conversations.id, conversationId));
    });

    const blocked = patch({ stageId: mine.id });
    await new Promise((resolve) => setTimeout(resolve, 300));
    release!();
    await other;
    await blocked;

    const rows = await transitions();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.toStageId).toBe(first.id);
  });
});

describe('the agent moves a lead', () => {
  it('writes one row against the agent with no user behind it', async () => {
    const first = await stageNamed('Новый лид');
    const second = await stageNamed('В диалоге');
    await db
      .update(conversations)
      .set({ stageId: first.id })
      .where(eq(conversations.id, conversationId));

    await turn(second.id);

    const rows = await transitions();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.fromStageId).toBe(first.id);
    expect(rows[0]!.fromName).toBe('Новый лид');
    expect(rows[0]!.toStageId).toBe(second.id);
    expect(rows[0]!.toName).toBe('В диалоге');
    expect(rows[0]!.movedBy).toBe('ai');
    // Nobody pressed anything. A user id here would put a person's name on a move a model
    // made, which is the one thing `moved_by_user_id` must never say.
    expect(rows[0]!.movedByUserId).toBeNull();
  });

  it('writes nothing from the sandbox', async () => {
    const first = await stageNamed('Новый лид');
    const second = await stageNamed('В диалоге');
    await db
      .update(conversations)
      .set({ stageId: first.id })
      .where(eq(conversations.id, conversationId));

    const result = await turn(second.id, { dryRun: true });

    // The sandbox runs the agent for real — same instructions, same knowledge — and says
    // what it would have done. It changes nothing about the lead, so a transition from it
    // would be the funnel counting a move that never happened.
    expect(result.stageId).toBe(second.id);
    expect((await db.select().from(conversations))[0]!.stageId).toBe(first.id);
    expect(await transitions()).toHaveLength(0);
  });

  it('writes nothing when the model names the stage the lead already stands in', async () => {
    const first = await stageNamed('Новый лид');
    await db
      .update(conversations)
      .set({ stageId: first.id })
      .where(eq(conversations.id, conversationId));

    await turn(first.id);

    expect(await transitions()).toHaveLength(0);
  });

  it('writes nothing when a turn moves no stage at all', async () => {
    await runTurn(db, deps(), { agentId, conversationId });

    expect(await transitions()).toHaveLength(0);
  });
});

/**
 * Каждый перенос и запись о нём — одна транзакция.
 *
 * `README.md` and `docs/statistics.md` both promise it in words: «либо есть и перенос, и
 * запись, либо нет ни того, ни другого». The failure it rules out is not a lost row but a
 * *silent* one — a lead standing in a stage the funnel has no record of it entering, which
 * makes every conversion below that stage quietly wrong and unfalsifiable forever.
 *
 * Forced with a trigger rather than by mocking, because what is under test is the database
 * boundary itself: a rejected insert has to take the `UPDATE` down with it, and only a real
 * transaction against a real Postgres can show that.
 */
describe('the move and the record of it', () => {
  /** Runs `body` with every insert into `stage_transitions` refused by the database. */
  async function refusingTransitions<T>(body: () => Promise<T>): Promise<T> {
    await db.execute(
      sql`create or replace function refuse_transition() returns trigger language plpgsql as $$
          begin raise exception 'stage_transitions write refused'; end $$`,
    );
    await db.execute(
      sql`create trigger refuse_transition before insert on stage_transitions
          for each row execute function refuse_transition()`,
    );
    try {
      return await body();
    } finally {
      await db.execute(sql`drop trigger if exists refuse_transition on stage_transitions`);
      await db.execute(sql`drop function if exists refuse_transition()`);
    }
  }

  /** Where the fixture's lead stands right now. */
  const standsIn = async () =>
    (
      await db
        .select({ stageId: conversations.stageId })
        .from(conversations)
        .where(eq(conversations.id, conversationId))
    )[0]!.stageId;

  it('rolls the operator’s move back when the record of it cannot be written', async () => {
    const first = await stageNamed('Новый лид');

    const res = await refusingTransitions(() => patch({ stageId: first.id }));

    expect(res.statusCode).not.toBe(200);
    // Neither happened. The operator sees an error and moves the card again; what he must
    // never get is a card that moved and a funnel that never heard about it.
    expect(await standsIn()).toBeNull();
    expect(await transitions()).toHaveLength(0);
  });

  it('rolls the agent’s move back when the record of it cannot be written', async () => {
    const first = await stageNamed('Новый лид');
    const second = await stageNamed('В диалоге');
    await db
      .update(conversations)
      .set({ stageId: first.id })
      .where(eq(conversations.id, conversationId));

    const result = await refusingTransitions(() => turn(second.id));

    // The turn reports itself failed, as it does for anything it could not apply — and the
    // lead is still where it was, so the report is the truth rather than a label on a move
    // that already committed.
    expect(result.outcome).toBe('failed');
    expect(await standsIn()).toBe(first.id);
    expect(await transitions()).toHaveLength(0);
  });
});
