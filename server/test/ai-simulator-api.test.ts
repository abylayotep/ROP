import { asc, eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client.js';
import {
  accounts,
  agents,
  aiReplies,
  aiSandboxSessions,
  aiSandboxTurns,
  contacts,
  conversations,
  messages,
  orders,
} from '../src/db/schema.js';
import { withDb } from './helpers/db.js';

async function seedAgent(db: Db, accountName: string, agentName = accountName) {
  const [account] = await db.insert(accounts).values({ name: accountName }).returning();
  const [agent] = await db
    .insert(agents)
    .values({ accountId: account!.id, name: agentName })
    .returning();
  return { accountId: account!.id, agentId: agent!.id };
}

let db: Awaited<ReturnType<typeof withDb>>;

beforeEach(async () => {
  db = await withDb();
});

describe('AI sandbox persistence', () => {
  it('stores sandbox state without creating production CRM or messaging rows', async () => {
    const owner = await seedAgent(db, 'Northwind');
    const [session] = await db
      .insert(aiSandboxSessions)
      .values({ ...owner, title: 'Delivery test', phone: '77001234567' })
      .returning();

    await db.insert(aiSandboxTurns).values({
      ...owner,
      sessionId: session!.id,
      revision: 1,
      userText: 'How much is delivery?',
      reply: 'Delivery is free.',
      configVersion: 3,
      model: 'openai/gpt-4o-mini',
      sourceIds: ['knowledge-item-1'],
      stageId: '11111111-1111-4111-8111-111111111111',
      stageName: 'Qualified',
      fields: [{ id: 'budget', name: 'Budget', value: '50000' }],
      outcome: 'sent',
    });

    expect(await db.select().from(aiSandboxSessions)).toHaveLength(1);
    expect(await db.select().from(aiSandboxTurns)).toHaveLength(1);
    expect(await db.select().from(contacts)).toEqual([]);
    expect(await db.select().from(conversations)).toEqual([]);
    expect(await db.select().from(messages)).toEqual([]);
    expect(await db.select().from(orders)).toEqual([]);
    expect(await db.select().from(aiReplies)).toEqual([]);
  });

  it('rejects a session or turn whose tenant and agent ownership do not match', async () => {
    const first = await seedAgent(db, 'First tenant');
    const second = await seedAgent(db, 'Second tenant');

    await expect(
      db.insert(aiSandboxSessions).values({
        accountId: first.accountId,
        agentId: second.agentId,
        title: 'Foreign session',
      }),
    ).rejects.toThrow();

    const [session] = await db
      .insert(aiSandboxSessions)
      .values({ ...first, title: 'Owned session' })
      .returning();

    await expect(
      db.insert(aiSandboxTurns).values({
        ...second,
        sessionId: session!.id,
        revision: 1,
        userText: 'Cross-tenant turn',
        configVersion: 1,
        model: 'openai/gpt-4o-mini',
        outcome: 'failed',
      }),
    ).rejects.toThrow();
  });

  it('starts at revision zero and advances the persisted session state atomically', async () => {
    const owner = await seedAgent(db, 'Revision tenant');
    const [created] = await db
      .insert(aiSandboxSessions)
      .values({ ...owner, title: 'Revision test' })
      .returning();

    expect(created).toMatchObject({
      revision: 0,
      stageId: null,
      stageName: null,
      fields: [],
      outcome: null,
      handoff: null,
    });

    const [advanced] = await db
      .update(aiSandboxSessions)
      .set({
        revision: sql`${aiSandboxSessions.revision} + 1`,
        stageId: '22222222-2222-4222-8222-222222222222',
        stageName: 'Qualified',
        fields: [{ id: 'city', name: 'City', value: 'Almaty' }],
        outcome: 'sent',
        handoff: null,
      })
      .where(eq(aiSandboxSessions.id, created!.id))
      .returning();

    expect(advanced).toMatchObject({
      revision: 1,
      stageId: '22222222-2222-4222-8222-222222222222',
      stageName: 'Qualified',
      fields: [{ id: 'city', name: 'City', value: 'Almaty' }],
      outcome: 'sent',
      handoff: null,
    });
  });

  it('orders turns by revision and refuses two turns at the same revision', async () => {
    const owner = await seedAgent(db, 'Ordered tenant');
    const [session] = await db
      .insert(aiSandboxSessions)
      .values({ ...owner, title: 'Ordered turns' })
      .returning();
    const turn = (revision: number, userText: string) => ({
      ...owner,
      sessionId: session!.id,
      revision,
      userText,
      configVersion: 1,
      model: 'openai/gpt-4o-mini',
      outcome: 'sent',
    });

    await db.insert(aiSandboxTurns).values(turn(2, 'Second'));
    await db.insert(aiSandboxTurns).values(turn(1, 'First'));

    const rows = await db
      .select({ revision: aiSandboxTurns.revision, userText: aiSandboxTurns.userText })
      .from(aiSandboxTurns)
      .where(eq(aiSandboxTurns.sessionId, session!.id))
      .orderBy(asc(aiSandboxTurns.revision));
    expect(rows).toEqual([
      { revision: 1, userText: 'First' },
      { revision: 2, userText: 'Second' },
    ]);
    await expect(db.insert(aiSandboxTurns).values(turn(2, 'Duplicate'))).rejects.toThrow();
  });

  it('cascades turns with their session and sessions with their agent', async () => {
    const owner = await seedAgent(db, 'Cascade tenant');
    const createSession = async (title: string) => {
      const [session] = await db
        .insert(aiSandboxSessions)
        .values({ ...owner, title })
        .returning();
      await db.insert(aiSandboxTurns).values({
        ...owner,
        sessionId: session!.id,
        revision: 1,
        userText: 'Hello',
        configVersion: 1,
        model: 'openai/gpt-4o-mini',
        outcome: 'sent',
      });
      return session!;
    };

    const first = await createSession('Delete directly');
    await db.delete(aiSandboxSessions).where(eq(aiSandboxSessions.id, first.id));
    expect(await db.select().from(aiSandboxTurns)).toEqual([]);

    await createSession('Delete through agent');
    await db.delete(agents).where(eq(agents.id, owner.agentId));
    expect(await db.select().from(aiSandboxSessions)).toEqual([]);
    expect(await db.select().from(aiSandboxTurns)).toEqual([]);
  });
});
