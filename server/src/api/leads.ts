import type { Lead, Member, Note, Order } from '@rakurs/contract';
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import {
  accountMembers,
  contacts,
  conversations,
  leadFields,
  leadValues,
  notes,
  orders,
  stages,
  users,
} from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import { isUuid } from '../lib/uuid.js';
import { requireAgent } from './require-agent.js';

const patchLead = z.object({
  // `null` clears the stage or the assignee; absent leaves it alone. Zod's `.nullable()`
  // plus `.optional()` is what tells those two apart.
  stageId: z.string().nullable().optional(),
  assignedTo: z.string().nullable().optional(),
});

const setValue = z.object({ value: z.string() });
const addNote = z.object({ body: z.string().trim().min(1) });

const toNote = (row: typeof notes.$inferSelect, authorName: string | null): Note => ({
  id: row.id,
  body: row.body,
  authorName,
  createdAt: row.createdAt.toISOString(),
});

const toOrder = (row: typeof orders.$inferSelect): Order => ({
  id: row.id,
  amount: row.amount,
  currency: row.currency,
  status: row.status as Order['status'],
  comment: row.comment,
  paidAt: row.paidAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
});

/**
 * Adds two amounts held as strings.
 *
 * In tiyn, so no float ever touches the money. `Number` on the cents of a single order is
 * safe — an amount is `numeric(14,2)`, whose cents fit in a double with room to spare —
 * and the running total stays an integer until it is formatted back.
 */
export function sumAmounts(values: string[]): string {
  const total = values.reduce((acc, value) => acc + Math.round(Number(value) * 100), 0);
  const sign = total < 0 ? '-' : '';
  const abs = Math.abs(total);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * The whole lead in one shape.
 *
 * Exported because every mutation here answers with it, and because tasks 5 and 6 reload
 * it after doing their own work.
 *
 * Takes the whole agent rather than its id: the lead carries the currency, which lives on
 * the agent, and a caller holding only an id could not fill it in. `req.agent` satisfies
 * this as it stands.
 */
export async function loadLead(
  db: Db,
  agent: { id: string; currency: string },
  conversationId: string,
): Promise<Lead> {
  if (!isUuid(conversationId)) throw new ApiError(404, 'Диалог не найден');

  const [row] = await db
    .select({ conversation: conversations, contact: contacts })
    .from(conversations)
    .innerJoin(contacts, eq(contacts.id, conversations.contactId))
    .where(and(eq(conversations.id, conversationId), eq(conversations.agentId, agent.id)));
  if (!row) throw new ApiError(404, 'Диалог не найден');

  const [assignee] = row.conversation.assignedTo
    ? await db
        .select({ name: users.name })
        .from(users)
        .where(eq(users.id, row.conversation.assignedTo))
    : [];

  const values = await db
    .select({ fieldId: leadValues.fieldId, value: leadValues.value })
    .from(leadValues)
    .innerJoin(leadFields, eq(leadFields.id, leadValues.fieldId))
    .where(eq(leadValues.conversationId, conversationId))
    .orderBy(asc(leadFields.position));

  const noteRows = await db
    .select({ note: notes, authorName: users.name })
    .from(notes)
    .leftJoin(users, eq(users.id, notes.authorId))
    .where(eq(notes.conversationId, conversationId))
    .orderBy(asc(notes.createdAt));

  const orderRows = await db
    .select()
    .from(orders)
    .where(eq(orders.conversationId, conversationId))
    .orderBy(asc(orders.createdAt));

  return {
    conversationId,
    contactName: row.contact.name,
    contactPhone: row.contact.phone,
    stageId: row.conversation.stageId,
    stageSetAt: row.conversation.stageSetAt?.toISOString() ?? null,
    stageSetBy: row.conversation.stageSetBy,
    assignedTo: row.conversation.assignedTo,
    assigneeName: assignee?.name ?? null,
    adHeadline: row.conversation.adHeadline,
    values,
    notes: noteRows.map(({ note, authorName }) => toNote(note, authorName)),
    orders: orderRows.map(toOrder),
    paidTotal: sumAmounts(
      orderRows.filter((order) => order.status === 'paid').map((order) => order.amount),
    ),
    currency: agent.currency,
  };
}

export function registerLeadRoutes(
  app: FastifyInstance,
  db: Db,
  guard: preHandlerHookHandler,
): void {
  const anyMember = requireAgent(db);

  app.get(
    '/api/agents/:agentId/conversations/:conversationId/lead',
    { preHandler: [guard, anyMember] },
    async (req): Promise<Lead> => {
      const { conversationId } = req.params as { conversationId: string };
      return loadLead(db, req.agent!, conversationId);
    },
  );

  app.patch(
    '/api/agents/:agentId/conversations/:conversationId/lead',
    { preHandler: [guard, anyMember] },
    async (req): Promise<Lead> => {
      const { conversationId } = req.params as { conversationId: string };
      const parsed = patchLead.safeParse(req.body);
      if (!parsed.success) throw new ApiError(400, 'Не удалось разобрать карточку');

      const current = await loadLead(db, req.agent!, conversationId);
      const patch: Partial<typeof conversations.$inferInsert> = {};

      if (parsed.data.stageId !== undefined && parsed.data.stageId !== current.stageId) {
        if (parsed.data.stageId !== null) {
          // Checked against this agent's stages, not just for existence: a stage id from
          // another company would otherwise put a lead in a column nobody here can see.
          if (!isUuid(parsed.data.stageId)) throw new ApiError(404, 'Стадия не найдена');
          const [stage] = await db
            .select({ id: stages.id })
            .from(stages)
            .where(and(eq(stages.id, parsed.data.stageId), eq(stages.agentId, req.agent!.id)));
          if (!stage) throw new ApiError(404, 'Стадия не найдена');
        }
        patch.stageId = parsed.data.stageId;
        patch.stageSetAt = new Date();
        // Stage 5 writes 'ai' here through the same column.
        patch.stageSetBy = 'operator';
      }

      if (parsed.data.assignedTo !== undefined && parsed.data.assignedTo !== current.assignedTo) {
        if (parsed.data.assignedTo !== null) {
          if (!isUuid(parsed.data.assignedTo)) throw new ApiError(404, 'Сотрудник не найден');
          const [membership] = await db
            .select({ userId: accountMembers.userId })
            .from(accountMembers)
            .where(
              and(
                eq(accountMembers.accountId, req.agent!.accountId),
                eq(accountMembers.userId, parsed.data.assignedTo),
              ),
            );
          if (!membership) throw new ApiError(404, 'Сотрудник не найден');
        }
        patch.assignedTo = parsed.data.assignedTo;
      }

      if (Object.keys(patch).length > 0) {
        await db
          .update(conversations)
          .set(patch)
          .where(
            and(eq(conversations.id, conversationId), eq(conversations.agentId, req.agent!.id)),
          );
      }
      return loadLead(db, req.agent!, conversationId);
    },
  );

  app.put(
    '/api/agents/:agentId/conversations/:conversationId/lead/fields/:fieldId',
    { preHandler: [guard, anyMember] },
    async (req): Promise<Lead> => {
      const { conversationId, fieldId } = req.params as {
        conversationId: string;
        fieldId: string;
      };
      const parsed = setValue.safeParse(req.body);
      if (!parsed.success) throw new ApiError(400, 'Не удалось разобрать значение');

      // Proves the conversation belongs to this agent before anything is written.
      await loadLead(db, req.agent!, conversationId);

      if (!isUuid(fieldId)) throw new ApiError(404, 'Поле не найдено');
      const [field] = await db
        .select({ id: leadFields.id })
        .from(leadFields)
        .where(and(eq(leadFields.id, fieldId), eq(leadFields.agentId, req.agent!.id)));
      if (!field) throw new ApiError(404, 'Поле не найдено');

      const value = parsed.data.value.trim();
      if (value === '') {
        // An emptied field is an unanswered field. Keeping a blank row would make the
        // panel show a filled-in field whose answer is nothing.
        await db
          .delete(leadValues)
          .where(
            and(eq(leadValues.conversationId, conversationId), eq(leadValues.fieldId, fieldId)),
          );
      } else {
        await db
          .insert(leadValues)
          .values({ conversationId, fieldId, value })
          .onConflictDoUpdate({
            target: [leadValues.conversationId, leadValues.fieldId],
            set: { value, updatedAt: new Date() },
          });
      }
      return loadLead(db, req.agent!, conversationId);
    },
  );

  app.post(
    '/api/agents/:agentId/conversations/:conversationId/notes',
    { preHandler: [guard, anyMember] },
    async (req): Promise<Lead> => {
      const { conversationId } = req.params as { conversationId: string };
      const parsed = addNote.safeParse(req.body);
      if (!parsed.success) throw new ApiError(400, 'Заметка не может быть пустой');

      await loadLead(db, req.agent!, conversationId);
      await db
        .insert(notes)
        .values({ conversationId, authorId: req.user!.id, body: parsed.data.body });
      return loadLead(db, req.agent!, conversationId);
    },
  );

  app.get(
    '/api/agents/:agentId/members',
    { preHandler: [guard, anyMember] },
    async (req): Promise<Member[]> => {
      const rows = await db
        .select({ user: users, role: accountMembers.role })
        .from(accountMembers)
        .innerJoin(users, eq(users.id, accountMembers.userId))
        .where(eq(accountMembers.accountId, req.agent!.accountId))
        .orderBy(asc(users.name));

      return rows.map(({ user, role }) => ({
        id: user.id,
        name: user.name,
        initials: user.initials,
        role: role === 'owner' ? 'owner' : 'member',
      }));
    },
  );
}
