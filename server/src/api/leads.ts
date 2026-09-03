import type { Lead, Member, Note, Order } from '@rakurs/contract';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import type { Env } from '../env.js';
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
import { queueLead } from '../lib/capi/enqueue.js';
import { ApiError } from '../lib/errors.js';
import { sendStageMessage } from '../lib/funnel-message.js';
import { credentialsKey } from '../lib/secret-box.js';
import { isUuid } from '../lib/uuid.js';
import type { GraphClient } from '../lib/whatsapp/graph.js';
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
    // Whether, not what. The click identifier is what Meta matches a purchase against and
    // it is captured once, from the first message; the lead card needs to know it exists so
    // it can say why a sale can — or can never — be reported, and nothing more.
    fromAd: row.conversation.ctwaClid !== null,
    aiEnabled: row.conversation.aiEnabled,
    values,
    notes: noteRows.map(({ note, authorName }) => toNote(note, authorName)),
    orders: orderRows.map(toOrder),
    paidTotal: sumAmounts(
      orderRows
        // The currency is checked, not assumed. `paidTotal` is reported next to the agent's
        // currency, and `orders.currency` is a per-row column: adding an amount held in
        // another currency into that total would print a number in a unit it is not in.
        // Nothing can change an agent's currency today, so this excludes nothing today —
        // it is one line now and an audit of every sum later.
        .filter((order) => order.status === 'paid' && order.currency === agent.currency)
        .map((order) => order.amount),
    ),
    currency: agent.currency,
  };
}

export function registerLeadRoutes(
  app: FastifyInstance,
  db: Db,
  env: Env,
  guard: preHandlerHookHandler,
  graph: GraphClient,
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
      // Two patches, not one: the stage move is written under a guard on the stage this
      // request read, and the assignee is not. See the write below for why.
      const stagePatch: Partial<typeof conversations.$inferInsert> = {};
      const assigneePatch: Partial<typeof conversations.$inferInsert> = {};

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
        stagePatch.stageId = parsed.data.stageId;
        stagePatch.stageSetAt = new Date();
        // Stage 5 writes 'ai' here through the same column.
        // The agent's own move in `lib/ai/turn.ts` is a COPY of this path, not a call to it:
        // the same guarded UPDATE, the same auto-message, the same queued conversion, with
        // `ai` in place of `operator`. A change here has to be made there too.
        stagePatch.stageSetBy = 'operator';
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
        assigneePatch.assignedTo = parsed.data.assignedTo;
      }

      const mine = and(
        eq(conversations.id, conversationId),
        eq(conversations.agentId, req.agent!.id),
      );

      /**
       * True when this request is the one that actually moved the lead.
       *
       * The stage write carries the stage it read in its WHERE, so of two requests that
       * read the same old stage exactly one updates a row and the other updates none.
       * Without that, both passed the gate below and the customer got the stage's template
       * twice.
       */
      let moved = false;

      await db.transaction(async (tx) => {
        // The assignee is written unguarded and separately. Folding it into the guarded
        // statement would make a lost stage race silently drop the assignee change too,
        // and the two answer different questions: an assignee is last-write-wins, while a
        // stage move that lost its race has already been made by somebody else, so losing
        // it is the right outcome — the reloaded lead below shows the operator where the
        // card really is.
        if (Object.keys(assigneePatch).length > 0) {
          await tx.update(conversations).set(assigneePatch).where(mine);
        }
        if (Object.keys(stagePatch).length > 0) {
          const rows = await tx
            .update(conversations)
            .set(stagePatch)
            .where(
              and(
                mine,
                // `= null` is never true, so an unsorted lead needs `is null` instead.
                current.stageId === null
                  ? isNull(conversations.stageId)
                  : eq(conversations.stageId, current.stageId),
              ),
            )
            .returning({ id: conversations.id });
          moved = rows.length > 0;
        }
      });

      // Only on a real move to a real stage, and never on the first one a lead is given:
      // a customer who has just written already has an answer, and a template on top of
      // it is the cabinet talking over its own operator.
      if (moved && stagePatch.stageId != null && current.stageId !== null) {
        await sendStageMessage(
          db,
          { graph, key: credentialsKey(env) },
          { agentId: req.agent!.id, conversationId, stageId: stagePatch.stageId },
        );
      }

      // Deliberately outside the guard above: a lead qualified by the very first stage it is
      // given is still a lead worth reporting, even though it gets no template. Only a move
      // this request actually made counts — `moved` is what keeps a lost race from reporting
      // a stage somebody else set.
      if (moved && stagePatch.stageId != null) {
        await queueLead(db, { agentId: req.agent!.id, conversationId });
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
