import type { LeadField, Stage } from '@rakurs/contract';
import { and, asc, count, eq, ne } from 'drizzle-orm';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { agents, conversations, leadFields, stages } from '../db/schema.js';
import { ApiError } from '../lib/errors.js';
import type { Executor } from '../lib/funnel.js';
import { isUuid } from '../lib/uuid.js';
import { requireAgent } from './require-agent.js';

const KINDS = ['active', 'qualified', 'awaiting_payment', 'success', 'failure'] as const;
const FIELD_KINDS = ['text', 'number', 'date'] as const;

const createStage = z.object({
  name: z.string().trim().min(1),
  color: z.string().trim().min(1),
  kind: z.enum(KINDS),
  description: z.string().trim().default(''),
  autoMessage: z.string().default(''),
});

const patchStage = z.object({
  name: z.string().trim().min(1).optional(),
  color: z.string().trim().min(1).optional(),
  kind: z.enum(KINDS).optional(),
  description: z.string().trim().optional(),
  autoMessage: z.string().optional(),
});

const reorder = z.object({ ids: z.array(z.string()).min(1) });

const createField = z.object({
  name: z.string().trim().min(1),
  kind: z.enum(FIELD_KINDS),
  hint: z.string().trim().default(''),
});

const patchField = z.object({
  name: z.string().trim().min(1).optional(),
  kind: z.enum(FIELD_KINDS).optional(),
  hint: z.string().trim().optional(),
});

const toStage = (row: typeof stages.$inferSelect): Stage => ({
  id: row.id,
  name: row.name,
  color: row.color,
  kind: row.kind as Stage['kind'],
  position: row.position,
  description: row.description,
  autoMessage: row.autoMessage,
});

const toField = (row: typeof leadFields.$inferSelect): LeadField => ({
  id: row.id,
  name: row.name,
  kind: row.kind as LeadField['kind'],
  hint: row.hint,
  position: row.position,
});

/**
 * An empty template means the stage sends nothing, and null is how the column says that.
 * Storing '' instead would leave the send path deciding what an empty message means.
 */
const template = (value: string | undefined): string | null | undefined =>
  value === undefined ? undefined : value.trim() === '' ? null : value;

/** Russian counts three ways: 1 диалог, 2 диалога, 5 диалогов. */
const plural = (n: number, one: string, few: string, many: string): string => {
  const teens = n % 100;
  if (teens >= 11 && teens <= 14) return many;
  const last = n % 10;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
};

export function registerStageRoutes(
  app: FastifyInstance,
  db: Db,
  guard: preHandlerHookHandler,
): void {
  const anyMember = requireAgent(db);
  const ownerOnly = requireAgent(db, { role: 'owner' });

  const listStages = (agentId: string, tx: Executor = db) =>
    tx.select().from(stages).where(eq(stages.agentId, agentId)).orderBy(asc(stages.position));

  /**
   * Locks the agent's row until the transaction ends.
   *
   * Serialises every transaction that can change a stage's `kind` or remove a stage — the
   * create, the patch and the delete — because the invariant those three share is "exactly
   * one stage of this agent has kind `success`", and that is a statement about the whole
   * funnel rather than about the row each of them writes. Under READ COMMITTED two owner
   * requests in flight (two promotions, or a promotion and a create) each fail to see the
   * other's uncommitted demotion, both commit, and the agent ends with two sale stages —
   * from which the cabinet cannot recover, because demoting either is then a 409 and
   * deleting either is a 409.
   *
   * The invariant is not a database constraint: a partial unique index on `agent_id` where
   * `kind = 'success'` would fire in the middle of a promotion, which demotes the incumbent
   * only after inserting or updating the new sale stage, and in the middle of the seeding
   * and the reorder — failing an owner's request with a Postgres message nobody can read
   * instead of the Russian sentence these routes answer with.
   */
  async function lockAgent(tx: Executor, agentId: string): Promise<void> {
    await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, agentId)).for('update');
  }

  /** The agent's stage, or a 404 that tells a stranger nothing. */
  async function loadStage(agentId: string, stageId: string, tx: Executor = db) {
    if (!isUuid(stageId)) throw new ApiError(404, 'Стадия не найдена');
    const [row] = await tx
      .select()
      .from(stages)
      .where(and(eq(stages.id, stageId), eq(stages.agentId, agentId)));
    if (!row) throw new ApiError(404, 'Стадия не найдена');
    return row;
  }

  /**
   * Makes one stage the sale, demoting whichever stage held that role.
   *
   * Promotion moves the sale rather than being refused: an owner who marks a stage as the
   * sale means exactly that, and refusing both this and the demotion of the incumbent would
   * leave no way to move the sale at all. The demoted stage becomes `active`, which is what
   * a stage in the middle of a funnel is.
   */
  async function takeSaleStage(tx: Executor, agentId: string, exceptId?: string): Promise<void> {
    const where = exceptId
      ? and(eq(stages.agentId, agentId), eq(stages.kind, 'success'), ne(stages.id, exceptId))
      : and(eq(stages.agentId, agentId), eq(stages.kind, 'success'));
    await tx.update(stages).set({ kind: 'active' }).where(where);
  }

  app.get(
    '/api/agents/:agentId/stages',
    { preHandler: [guard, anyMember] },
    async (req): Promise<Stage[]> => (await listStages(req.agent!.id)).map(toStage),
  );

  app.post(
    '/api/agents/:agentId/stages',
    { preHandler: [guard, ownerOnly] },
    async (req): Promise<Stage> => {
      const parsed = createStage.safeParse(req.body);
      if (!parsed.success) throw new ApiError(400, 'Укажите название, цвет и тип стадии');

      const row = await db.transaction(async (tx) => {
        await lockAgent(tx, req.agent!.id);
        // Read after the lock: the last position, like the sale stage, is a fact about the
        // whole funnel, and one read outside the transaction would let two creates agree.
        const existing = await listStages(req.agent!.id, tx);
        if (parsed.data.kind === 'success') await takeSaleStage(tx, req.agent!.id);
        const [created] = await tx
          .insert(stages)
          .values({
            agentId: req.agent!.id,
            name: parsed.data.name,
            color: parsed.data.color,
            kind: parsed.data.kind,
            description: parsed.data.description,
            autoMessage: template(parsed.data.autoMessage) ?? null,
            position: (existing.at(-1)?.position ?? -1) + 1,
          })
          .returning();
        return created!;
      });
      return toStage(row);
    },
  );

  app.patch(
    '/api/agents/:agentId/stages/:stageId',
    { preHandler: [guard, ownerOnly] },
    async (req): Promise<Stage> => {
      const { stageId } = req.params as { stageId: string };

      const parsed = patchStage.safeParse(req.body);
      if (!parsed.success) throw new ApiError(400, 'Не удалось разобрать стадию');

      const row = await db.transaction(async (tx) => {
        await lockAgent(tx, req.agent!.id);
        // Read after the lock, not before: a `kind` read outside the transaction is a
        // guess about a funnel another request may already have reshaped.
        const current = await loadStage(req.agent!.id, stageId, tx);
        if (Object.keys(parsed.data).length === 0) return current;

        if (
          parsed.data.kind !== undefined &&
          parsed.data.kind !== current.kind &&
          current.kind === 'success'
        ) {
          // Refused rather than allowed and warned about: with no sale stage the board
          // still works, but every number stage 6 and stage 7 report becomes a zero.
          throw new ApiError(
            409,
            'У воронки должна быть стадия продажи. Сначала назначьте продажей другую стадию.',
          );
        }

        if (parsed.data.kind === 'success' && current.kind !== 'success') {
          await takeSaleStage(tx, req.agent!.id, current.id);
        }
        const [updated] = await tx
          .update(stages)
          .set({ ...parsed.data, autoMessage: template(parsed.data.autoMessage) })
          .where(eq(stages.id, current.id))
          .returning();
        return updated!;
      });
      return toStage(row);
    },
  );

  app.delete(
    '/api/agents/:agentId/stages/:stageId',
    { preHandler: [guard, ownerOnly] },
    async (req): Promise<{ ok: true }> => {
      const { stageId } = req.params as { stageId: string };

      // Every check and the delete share one transaction: read outside it and a promotion
      // landing in between would let this delete take the funnel's last sale stage.
      await db.transaction(async (tx) => {
        await lockAgent(tx, req.agent!.id);
        const current = await loadStage(req.agent!.id, stageId, tx);

        if (current.kind === 'success') {
          throw new ApiError(409, 'Это стадия продажи. Назначьте продажей другую и повторите.');
        }

        // Deleting would set every conversation's stage to null and silently empty a
        // column of the board. Refused with the number, so the owner knows what is at stake.
        const [holders] = await tx
          .select({ held: count() })
          .from(conversations)
          .where(eq(conversations.stageId, current.id));
        const held = holders?.held ?? 0;
        if (held > 0) {
          throw new ApiError(
            409,
            `В стадии ${held} ${plural(held, 'диалог', 'диалога', 'диалогов')}. Перенесите их в другую стадию и повторите.`,
          );
        }

        await tx.delete(stages).where(eq(stages.id, current.id));
      });
      return { ok: true };
    },
  );

  app.post(
    '/api/agents/:agentId/stages/order',
    { preHandler: [guard, ownerOnly] },
    async (req): Promise<Stage[]> => {
      const parsed = reorder.safeParse(req.body);
      if (!parsed.success) throw new ApiError(400, 'Передайте порядок стадий');

      const existing = await listStages(req.agent!.id);
      const given = new Set(parsed.data.ids);
      // The whole list or nothing: a partial reorder would have to guess where the
      // stages nobody mentioned belong, and every guess leaves two of them level.
      if (given.size !== parsed.data.ids.length || given.size !== existing.length) {
        throw new ApiError(400, 'В порядке должны быть все стадии по одному разу');
      }
      if (!existing.every((stage) => given.has(stage.id))) {
        throw new ApiError(400, 'В порядке есть стадия из другой воронки');
      }

      await db.transaction(async (tx) => {
        for (const [position, id] of parsed.data.ids.entries()) {
          await tx
            .update(stages)
            .set({ position })
            .where(and(eq(stages.id, id), eq(stages.agentId, req.agent!.id)));
        }
      });
      return (await listStages(req.agent!.id)).map(toStage);
    },
  );

  /* ── Lead fields ─────────────────────────────────────────────────────────── */

  const listFields = (agentId: string) =>
    db
      .select()
      .from(leadFields)
      .where(eq(leadFields.agentId, agentId))
      .orderBy(asc(leadFields.position));

  app.get(
    '/api/agents/:agentId/lead-fields',
    { preHandler: [guard, anyMember] },
    async (req): Promise<LeadField[]> => (await listFields(req.agent!.id)).map(toField),
  );

  app.post(
    '/api/agents/:agentId/lead-fields',
    { preHandler: [guard, ownerOnly] },
    async (req): Promise<LeadField> => {
      const parsed = createField.safeParse(req.body);
      if (!parsed.success) throw new ApiError(400, 'Укажите название и тип поля');

      const existing = await listFields(req.agent!.id);
      if (existing.some((field) => field.name === parsed.data.name)) {
        throw new ApiError(409, 'Поле с таким названием уже есть');
      }

      const [row] = await db
        .insert(leadFields)
        .values({
          agentId: req.agent!.id,
          ...parsed.data,
          position: (existing.at(-1)?.position ?? -1) + 1,
        })
        .returning();
      return toField(row!);
    },
  );

  app.patch(
    '/api/agents/:agentId/lead-fields/:fieldId',
    { preHandler: [guard, ownerOnly] },
    async (req): Promise<LeadField> => {
      const { fieldId } = req.params as { fieldId: string };
      if (!isUuid(fieldId)) throw new ApiError(404, 'Поле не найдено');

      const parsed = patchField.safeParse(req.body);
      if (!parsed.success) throw new ApiError(400, 'Не удалось разобрать поле');

      const [current] = await db
        .select()
        .from(leadFields)
        .where(and(eq(leadFields.id, fieldId), eq(leadFields.agentId, req.agent!.id)));
      if (!current) throw new ApiError(404, 'Поле не найдено');
      if (Object.keys(parsed.data).length === 0) return toField(current);

      if (parsed.data.name !== undefined && parsed.data.name !== current.name) {
        const existing = await listFields(req.agent!.id);
        if (existing.some((field) => field.name === parsed.data.name)) {
          throw new ApiError(409, 'Поле с таким названием уже есть');
        }
      }

      const [row] = await db
        .update(leadFields)
        .set(parsed.data)
        .where(eq(leadFields.id, current.id))
        .returning();
      return toField(row!);
    },
  );

  app.delete(
    '/api/agents/:agentId/lead-fields/:fieldId',
    { preHandler: [guard, ownerOnly] },
    async (req): Promise<{ ok: true }> => {
      const { fieldId } = req.params as { fieldId: string };
      if (!isUuid(fieldId)) throw new ApiError(404, 'Поле не найдено');

      // The values cascade with the field. Said here because it is not obvious from the
      // call site: removing a field removes what every lead answered for it.
      const deleted = await db
        .delete(leadFields)
        .where(and(eq(leadFields.id, fieldId), eq(leadFields.agentId, req.agent!.id)))
        .returning({ id: leadFields.id });
      if (deleted.length === 0) throw new ApiError(404, 'Поле не найдено');
      return { ok: true };
    },
  );

  app.post(
    '/api/agents/:agentId/lead-fields/order',
    { preHandler: [guard, ownerOnly] },
    async (req): Promise<LeadField[]> => {
      const parsed = reorder.safeParse(req.body);
      if (!parsed.success) throw new ApiError(400, 'Передайте порядок полей');

      const existing = await listFields(req.agent!.id);
      const given = new Set(parsed.data.ids);
      // Taken whole for the same reason the stages are: a partial order has to guess
      // where the fields nobody named belong, and every guess leaves two of them level.
      if (given.size !== parsed.data.ids.length || given.size !== existing.length) {
        throw new ApiError(400, 'В порядке должны быть все поля по одному разу');
      }
      if (!existing.every((field) => given.has(field.id))) {
        throw new ApiError(400, 'В порядке есть поле из другой воронки');
      }

      // One transaction, so a refusal cannot leave half the list renumbered: the order
      // of the fields is the order of the boxes in every lead card, and a half-applied
      // rewrite is a card nobody arranged.
      await db.transaction(async (tx) => {
        for (const [position, id] of parsed.data.ids.entries()) {
          await tx
            .update(leadFields)
            .set({ position })
            .where(and(eq(leadFields.id, id), eq(leadFields.agentId, req.agent!.id)));
        }
      });
      return (await listFields(req.agent!.id)).map(toField);
    },
  );
}
