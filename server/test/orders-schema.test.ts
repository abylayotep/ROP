import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  accounts,
  agents,
  contacts,
  conversations,
  leadFields,
  leadValues,
  notes,
  orders,
  stages,
  users,
  whatsappNumbers,
} from '../src/db/schema.js';
import { withDb } from './helpers/db.js';

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

  return { agentId: agent!.id, conversationId: conversation!.id };
}

describe('orders schema', () => {
  it('defaults an agent to tenge', async () => {
    const db = await withDb();
    const { agentId } = await seed(db);

    const [row] = await db.select().from(agents).where(eq(agents.id, agentId));

    expect(row?.currency).toBe('KZT');
  });

  it('stores a stage with its kind, position and template', async () => {
    const db = await withDb();
    const { agentId } = await seed(db);

    const [stage] = await db
      .insert(stages)
      .values({
        agentId,
        name: 'Продажа',
        color: '#0d9668',
        kind: 'success',
        position: 8,
        autoMessage: 'Спасибо за покупку, {{name}}!',
      })
      .returning();

    expect(stage?.kind).toBe('success');
    expect(stage?.position).toBe(8);
    expect(stage?.description).toBe('');
    expect(stage?.autoMessage).toBe('Спасибо за покупку, {{name}}!');
  });

  it('keeps a conversation when its stage is deleted', async () => {
    const db = await withDb();
    const { agentId, conversationId } = await seed(db);
    const [stage] = await db
      .insert(stages)
      .values({ agentId, name: 'Новый лид', color: '#8a94a6', kind: 'active', position: 0 })
      .returning();
    await db
      .update(conversations)
      .set({ stageId: stage!.id, stageSetAt: new Date(), stageSetBy: 'operator' })
      .where(eq(conversations.id, conversationId));

    await db.delete(stages).where(eq(stages.id, stage!.id));

    const [row] = await db.select().from(conversations).where(eq(conversations.id, conversationId));
    expect(row).toBeDefined();
    expect(row?.stageId).toBeNull();
  });

  it('refuses two lead fields with one name on one agent', async () => {
    const db = await withDb();
    const { agentId } = await seed(db);
    const value = { agentId, name: 'Город', kind: 'text', position: 0 };
    await db.insert(leadFields).values(value);

    await expect(db.insert(leadFields).values(value)).rejects.toThrow();
  });

  it('holds one value per field per conversation', async () => {
    const db = await withDb();
    const { agentId, conversationId } = await seed(db);
    const [leadField] = await db
      .insert(leadFields)
      .values({ agentId, name: 'Город', kind: 'text', position: 0 })
      .returning();

    await db
      .insert(leadValues)
      .values({ conversationId, fieldId: leadField!.id, value: 'Алматы' });
    await db
      .insert(leadValues)
      .values({ conversationId, fieldId: leadField!.id, value: 'Астана' })
      .onConflictDoUpdate({
        target: [leadValues.conversationId, leadValues.fieldId],
        set: { value: 'Астана' },
      });

    const rows = await db.select().from(leadValues);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toBe('Астана');
  });

  it('keeps an amount exact to the tiyn', async () => {
    const db = await withDb();
    const { agentId, conversationId } = await seed(db);

    const [order] = await db
      .insert(orders)
      .values({ agentId, conversationId, amount: '1234567.89', currency: 'KZT' })
      .returning();

    // numeric arrives as a string on purpose: a float would round this.
    expect(order?.amount).toBe('1234567.89');
    expect(order?.status).toBe('pending');
    expect(order?.paidAt).toBeNull();
  });

  it('deletes notes and orders with their conversation', async () => {
    const db = await withDb();
    const { agentId, conversationId } = await seed(db);
    await db.insert(notes).values({ conversationId, body: 'Просил перезвонить в среду' });
    await db.insert(orders).values({ agentId, conversationId, amount: '1000', currency: 'KZT' });

    await db.delete(conversations).where(eq(conversations.id, conversationId));

    expect(await db.select().from(notes)).toHaveLength(0);
    expect(await db.select().from(orders)).toHaveLength(0);
  });

  it('keeps a lead and its notes when the employee handling them is deleted', async () => {
    const db = await withDb();
    const { conversationId } = await seed(db);
    const [user] = await db
      .insert(users)
      .values({
        email: 'safina@example.com',
        passwordHash: 'x',
        name: 'Сафина',
        initials: 'С',
      })
      .returning();
    await db
      .update(conversations)
      .set({ assignedTo: user!.id })
      .where(eq(conversations.id, conversationId));
    await db
      .insert(notes)
      .values({ conversationId, authorId: user!.id, body: 'Просил перезвонить в среду' });

    await db.delete(users).where(eq(users.id, user!.id));

    // Customer data outlives the employee: both columns are `set null`, never cascade.
    const [conversation] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    expect(conversation?.assignedTo).toBeNull();
    const [note] = await db.select().from(notes);
    expect(note?.body).toBe('Просил перезвонить в среду');
    expect(note?.authorId).toBeNull();
  });
});
