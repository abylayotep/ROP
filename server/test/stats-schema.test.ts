import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  accounts,
  agents,
  contacts,
  conversations,
  stageTransitions,
  stages,
  users,
  whatsappNumbers,
} from '../src/db/schema.js';
import { withDb } from './helpers/db.js';

let db: Awaited<ReturnType<typeof withDb>>;

beforeEach(async () => {
  db = await withDb();
});

/** An agent with one conversation and two stages — the fixture every move here starts from. */
async function seed() {
  const [account] = await db.insert(accounts).values({ name: 'Сафина' }).returning();
  const [agent] = await db
    .insert(agents)
    .values({ accountId: account!.id, name: 'Сафина' })
    .returning();
  const [number] = await db
    .insert(whatsappNumbers)
    .values({
      agentId: agent!.id,
      phoneNumberId: `pn-${Math.random().toString(36).slice(2)}`,
      wabaId: 'waba',
      displayPhone: '+7 708 580 79 32',
      accessToken: 'x',
    })
    .returning();
  const [contact] = await db
    .insert(contacts)
    .values({ agentId: agent!.id, phone: '77085807932' })
    .returning();
  const [conversation] = await db
    .insert(conversations)
    .values({ agentId: agent!.id, contactId: contact!.id, whatsappNumberId: number!.id })
    .returning();
  const [from] = await db
    .insert(stages)
    .values({ agentId: agent!.id, name: 'Новый лид', color: '#8a94a6', kind: 'active', position: 0 })
    .returning();
  const [to] = await db
    .insert(stages)
    .values({ agentId: agent!.id, name: 'Продажа', color: '#0d9668', kind: 'success', position: 7 })
    .returning();

  return {
    agentId: agent!.id,
    conversationId: conversation!.id,
    fromStageId: from!.id,
    toStageId: to!.id,
  };
}

/** The employee who moved the lead. */
async function seedUser() {
  const [user] = await db
    .insert(users)
    .values({ email: 'safina@example.com', passwordHash: 'x', name: 'Сафина', initials: 'С' })
    .returning();
  return user!.id;
}

describe('stage transitions schema', () => {
  it('stores a move with both the stage ids and their snapshot', async () => {
    const { agentId, conversationId, fromStageId, toStageId } = await seed();
    const movedByUserId = await seedUser();
    const occurredAt = new Date('2026-09-01T10:00:00.000Z');

    const [row] = await db
      .insert(stageTransitions)
      .values({
        agentId,
        conversationId,
        fromStageId,
        toStageId,
        fromName: 'Новый лид',
        toName: 'Продажа',
        toKind: 'success',
        fromPosition: 0,
        toPosition: 7,
        movedBy: 'operator',
        movedByUserId,
        occurredAt,
      })
      .returning();

    expect(row).toMatchObject({
      agentId,
      conversationId,
      fromStageId,
      toStageId,
      fromName: 'Новый лид',
      toName: 'Продажа',
      toKind: 'success',
      fromPosition: 0,
      toPosition: 7,
      movedBy: 'operator',
      movedByUserId,
      occurredAt,
    });
    expect(row!.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('takes now for a move that does not say when, and nothing for where it came from', async () => {
    const { agentId, conversationId, toStageId } = await seed();

    const [row] = await db
      .insert(stageTransitions)
      .values({
        agentId,
        conversationId,
        toStageId,
        toName: 'Продажа',
        toKind: 'success',
        toPosition: 7,
        movedBy: 'system',
      })
      .returning();

    // A lead entering its first stage came from nowhere: both `from` columns are null.
    expect(row!.fromStageId).toBeNull();
    expect(row!.fromName).toBeNull();
    expect(row!.fromPosition).toBeNull();
    expect(row!.movedByUserId).toBeNull();
    expect(Date.now() - row!.occurredAt.getTime()).toBeLessThan(60_000);
  });

  it('keeps the move readable after the stage it went to is deleted', async () => {
    const { agentId, conversationId, fromStageId, toStageId } = await seed();
    await db.insert(stageTransitions).values({
      agentId,
      conversationId,
      fromStageId,
      toStageId,
      fromName: 'Новый лид',
      toName: 'Продажа',
      toKind: 'success',
      fromPosition: 0,
      toPosition: 7,
      movedBy: 'ai',
    });

    await db.delete(stages).where(eq(stages.id, toStageId));

    // The id goes, the snapshot stays: an owner deleting an empty stage must not erase
    // which stage the lead passed through.
    const [row] = await db.select().from(stageTransitions);
    expect(row).toBeDefined();
    expect(row!.toStageId).toBeNull();
    expect(row!.toName).toBe('Продажа');
    expect(row!.toKind).toBe('success');
    expect(row!.toPosition).toBe(7);
    expect(row!.fromStageId).toBe(fromStageId);
  });

  it('keeps the move readable after the stage it came from is deleted', async () => {
    const { agentId, conversationId, fromStageId, toStageId } = await seed();
    await db.insert(stageTransitions).values({
      agentId,
      conversationId,
      fromStageId,
      toStageId,
      fromName: 'Новый лид',
      toName: 'Продажа',
      toKind: 'success',
      fromPosition: 0,
      toPosition: 7,
      movedBy: 'scenario',
    });

    await db.delete(stages).where(eq(stages.id, fromStageId));

    const [row] = await db.select().from(stageTransitions);
    expect(row!.fromStageId).toBeNull();
    expect(row!.fromName).toBe('Новый лид');
    expect(row!.fromPosition).toBe(0);
    expect(row!.toStageId).toBe(toStageId);
  });

  it('deletes the moves of a conversation with the conversation', async () => {
    const { agentId, conversationId, toStageId } = await seed();
    await db.insert(stageTransitions).values({
      agentId,
      conversationId,
      toStageId,
      toName: 'Продажа',
      toKind: 'success',
      toPosition: 7,
      movedBy: 'operator',
    });

    await db.delete(conversations).where(eq(conversations.id, conversationId));

    // Cascade, not set null: the funnel counts distinct conversations, and a row without one
    // cannot be counted distinctly without inventing an identity for it.
    expect(await db.select().from(stageTransitions)).toHaveLength(0);
  });

  it('deletes the moves of an agent with the agent', async () => {
    const { agentId, conversationId, toStageId } = await seed();
    await db.insert(stageTransitions).values({
      agentId,
      conversationId,
      toStageId,
      toName: 'Продажа',
      toKind: 'success',
      toPosition: 7,
      movedBy: 'operator',
    });

    await db.delete(agents).where(eq(agents.id, agentId));

    expect(await db.select().from(stageTransitions)).toHaveLength(0);
  });

  it('keeps a move after the employee who made it is deleted', async () => {
    const { agentId, conversationId, toStageId } = await seed();
    const movedByUserId = await seedUser();
    await db.insert(stageTransitions).values({
      agentId,
      conversationId,
      toStageId,
      toName: 'Продажа',
      toKind: 'success',
      toPosition: 7,
      movedBy: 'operator',
      movedByUserId,
    });

    await db.delete(users).where(eq(users.id, movedByUserId));

    // The move is history and outlives the employee, the way a note does.
    const [row] = await db.select().from(stageTransitions);
    expect(row).toBeDefined();
    expect(row!.movedByUserId).toBeNull();
    expect(row!.movedBy).toBe('operator');
  });
});

describe('the recording point', () => {
  it('stamps an agent with the instant its history begins', async () => {
    const { agentId } = await seed();

    const [row] = await db.select().from(agents).where(eq(agents.id, agentId));

    expect(row!.stageHistorySince).not.toBeNull();
    expect(Date.now() - row!.stageHistorySince.getTime()).toBeLessThan(60_000);
  });

  it('leaves no agent without one, including those that predate the column', async () => {
    // `not null default now()` is what stamps rows that already exist: adding the column
    // writes the migration's own `now()` into every agent the cabinet has been running with
    // for months. Asserted here on the shape of the column rather than on those rows, which
    // this freshly migrated database does not have — the harness truncates them away.
    const columns = await db.execute(sql`
      select is_nullable, column_default from information_schema.columns
      where table_name = 'agents' and column_name = 'stage_history_since'
    `);

    const rows = [...columns];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.is_nullable).toBe('NO');
    expect(rows[0]?.column_default).toBe('now()');
    expect(await db.select().from(agents).where(sql`stage_history_since is null`)).toHaveLength(0);
  });
});
