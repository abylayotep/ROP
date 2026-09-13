import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { AiSettings } from '@rakurs/contract';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  accounts,
  agents,
  aiReplies,
  contacts,
  conversations,
  messages,
  whatsappNumbers,
} from '../src/db/schema.js';
import { withDb } from './helpers/db.js';
import { ADMIN_URL, runMigration, tagsBefore, withDatabase } from './helpers/migration-db.js';

const RESPONSE_MODE_MIGRATION = '0028_sparkling_vampiro';

/** An agent with one conversation on it — the fixture every case here starts from. */
async function seed(db: Awaited<ReturnType<typeof withDb>>) {
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
    .values({
      agentId: agent!.id,
      contactId: contact!.id,
      whatsappNumberId: number!.id,
    })
    .returning();

  return { agentId: agent!.id, contactId: contact!.id, conversationId: conversation!.id };
}

describe('ai schema', () => {
  it('starts an agent with the AI off and nothing written', async () => {
    const db = await withDb();
    const { agentId } = await seed(db);

    const [row] = await db.select().from(agents).where(eq(agents.id, agentId));

    expect(row?.aiEnabled).toBe(false);
    expect(row?.responseMode).toBe('off');
    expect(row?.testContactId).toBeNull();
    expect(row?.model).toBe('openai/gpt-4o-mini');
    // numeric arrives as a string on purpose: a temperature must not drift through a float.
    expect(row?.temperature).toBe('0.30');
    expect(row?.replyLanguage).toBe('auto');
    expect(row?.openrouterKey).toBeNull();
  });

  it.each(['off', 'test', 'live'] as const)('round-trips the %s response mode', async (responseMode) => {
    const db = await withDb();
    const { agentId } = await seed(db);

    const [updated] = await db
      .update(agents)
      .set({ responseMode })
      .where(eq(agents.id, agentId))
      .returning();

    expect(updated?.responseMode).toBe(responseMode);
  });

  it('clears the selected test contact when the contact is deleted', async () => {
    const db = await withDb();
    const { agentId, contactId } = await seed(db);
    await db.update(agents).set({ testContactId: contactId }).where(eq(agents.id, agentId));

    await db.delete(contacts).where(eq(contacts.id, contactId));

    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(agent?.testContactId).toBeNull();
  });

  it('exposes the selected contact summary through the AI settings contract', () => {
    const settings = {
      aiEnabled: false,
      responseMode: 'test',
      crmAnalysisMode: 'follow_ai',
      testContact: { id: 'contact-id', name: 'Tester', phone: '77001234567' },
      model: 'openai/gpt-4o-mini',
      temperature: 0.3,
      replyLanguage: 'auto',
      keySet: false,
    } satisfies AiSettings;

    expect(settings.testContact).toEqual({
      id: 'contact-id',
      name: 'Tester',
      phone: '77001234567',
    });
  });

  it('starts a conversation with the AI on', async () => {
    const db = await withDb();
    const { conversationId } = await seed(db);

    const [row] = await db.select().from(conversations).where(eq(conversations.id, conversationId));

    // The per-conversation switch defaults to on: turning the agent off for everyone
    // is the other switch, on the agent itself.
    expect(row?.aiEnabled).toBe(true);
  });

  it('logs a turn with its model, its tokens and its cost', async () => {
    const db = await withDb();
    const { agentId, conversationId } = await seed(db);
    const [message] = await db
      .insert(messages)
      .values({
        conversationId,
        direction: 'out',
        author: 'ai',
        kind: 'text',
        body: 'Доставка по Алматы бесплатная.',
        sentAt: new Date(),
      })
      .returning();

    const [reply] = await db
      .insert(aiReplies)
      .values({
        agentId,
        conversationId,
        messageId: message!.id,
        model: 'openai/gpt-4o-mini',
        promptTokens: 1840,
        completionTokens: 96,
        cost: '0.00042100',
        outcome: 'sent',
        usedItemIds: ['a3f1', 'b7c2'],
      })
      .returning();

    expect(reply?.model).toBe('openai/gpt-4o-mini');
    expect(reply?.promptTokens).toBe(1840);
    expect(reply?.completionTokens).toBe(96);
    // numeric arrives as a string on purpose, the same way an order's amount does.
    expect(reply?.cost).toBe('0.00042100');
    expect(reply?.outcome).toBe('sent');
    expect(reply?.detail).toBeNull();
    expect(reply?.usedItemIds).toEqual(['a3f1', 'b7c2']);
  });

  it('defaults a turn that produced nothing to zero cost and no message', async () => {
    const db = await withDb();
    const { agentId, conversationId } = await seed(db);

    const [reply] = await db
      .insert(aiReplies)
      .values({
        agentId,
        conversationId,
        model: 'openai/gpt-4o-mini',
        outcome: 'handoff',
        detail: 'Ничего не нашлось в базе знаний',
      })
      .returning();

    expect(reply?.messageId).toBeNull();
    expect(reply?.promptTokens).toBe(0);
    expect(reply?.completionTokens).toBe(0);
    expect(reply?.cost).toBe('0.00000000');
    expect(reply?.usedItemIds).toEqual([]);
  });

  it('deletes a turn log with its conversation', async () => {
    const db = await withDb();
    const { agentId, conversationId } = await seed(db);
    await db
      .insert(aiReplies)
      .values({ agentId, conversationId, model: 'openai/gpt-4o-mini', outcome: 'sent' });

    await db.delete(conversations).where(eq(conversations.id, conversationId));

    expect(await db.select().from(aiReplies)).toHaveLength(0);
  });

  it('deletes a turn log with its agent', async () => {
    const db = await withDb();
    const { agentId, conversationId } = await seed(db);
    await db
      .insert(aiReplies)
      .values({ agentId, conversationId, model: 'openai/gpt-4o-mini', outcome: 'sent' });

    await db.delete(agents).where(eq(agents.id, agentId));

    expect(await db.select().from(aiReplies)).toHaveLength(0);
  });
});

describe('response mode migration', () => {
  const dbName = `rakurs_response_mode_${randomUUID().replace(/-/g, '')}`;
  let adminSql: postgres.Sql;
  let scratchSql: postgres.Sql;

  beforeAll(async () => {
    adminSql = postgres(ADMIN_URL, { max: 1 });
    await adminSql.unsafe(`CREATE DATABASE "${dbName}"`);
    scratchSql = postgres(withDatabase(ADMIN_URL, dbName), { max: 1 });

    for (const tag of tagsBefore(RESPONSE_MODE_MIGRATION)) {
      await runMigration(scratchSql, tag);
    }

    const [account] = await scratchSql`
      INSERT INTO accounts (name) VALUES ('Existing account') RETURNING id
    `;
    await scratchSql`
      INSERT INTO agents (account_id, name, ai_enabled)
      VALUES (${account!.id}, 'Disabled agent', false), (${account!.id}, 'Enabled agent', true)
    `;

    await runMigration(scratchSql, RESPONSE_MODE_MIGRATION);
  });

  afterAll(async () => {
    await scratchSql?.end();
    await adminSql?.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await adminSql?.end();
  });

  it('preserves existing agent behavior while new agents default to off', async () => {
    const existing = await scratchSql`
      SELECT name, response_mode FROM agents ORDER BY name
    `;
    const [created] = await scratchSql`
      INSERT INTO agents (account_id, name)
      SELECT account_id, 'New agent' FROM agents LIMIT 1
      RETURNING response_mode
    `;

    expect(existing).toMatchObject([
      { name: 'Disabled agent', response_mode: 'off' },
      { name: 'Enabled agent', response_mode: 'live' },
    ]);
    expect(created!.response_mode).toBe('off');
  });

  it('rejects response modes outside the supported set', async () => {
    await expect(
      scratchSql`UPDATE agents SET response_mode = 'staging'`,
    ).rejects.toThrow(/agents_response_mode_check/);
  });
});
