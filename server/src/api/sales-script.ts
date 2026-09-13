import { randomUUID } from 'node:crypto';
import type { SalesScript } from '@rakurs/contract';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { agents, leadFields, productPhotos, products, salesScriptSteps, stages } from '../db/schema.js';
import {
  SCRIPT_CONDITION_MAX,
  SCRIPT_HANDOFF_NOTE_MAX,
  SCRIPT_INSTRUCTIONS_MAX,
  SCRIPT_STEP_FIELDS,
  SCRIPT_STEP_LIMIT,
  SCRIPT_STEP_PHOTOS,
  SCRIPT_TITLE_MAX,
  loadScript,
  toScriptStep,
} from '../lib/ai/sales-script.js';
import { bumpConfigVersion } from '../lib/drafts/version.js';
import { ApiError } from '../lib/errors.js';
import type { Executor } from '../lib/funnel.js';
import { isUuid } from '../lib/uuid.js';
import { requireAgent } from './require-agent.js';

/** A client id for a step the editor has just added. Never stored: the server mints the uuid. */
const TMP_ID = /^tmp-[A-Za-z0-9_-]{1,40}$/;

const stepId = z.string().refine((value) => TMP_ID.test(value) || isUuid(value));

const stepInput = z.object({
  id: stepId,
  parentId: stepId.nullable().default(null),
  title: z.string().trim().min(1).max(SCRIPT_TITLE_MAX),
  condition: z.string().trim().max(SCRIPT_CONDITION_MAX).default(''),
  instructions: z.string().trim().max(SCRIPT_INSTRUCTIONS_MAX).default(''),
  stageId: z.string().refine(isUuid).nullable().default(null),
  photoIds: z.array(z.string().refine(isUuid)).max(SCRIPT_STEP_PHOTOS).default([]),
  fieldIds: z.array(z.string().refine(isUuid)).max(SCRIPT_STEP_FIELDS).default([]),
  handoff: z.boolean().default(false),
  handoffNote: z.string().trim().max(SCRIPT_HANDOFF_NOTE_MAX).default(''),
  waitPayment: z.boolean().default(false),
});

const saveBody = z.object({ steps: z.array(stepInput).max(SCRIPT_STEP_LIMIT) });

type StepInput = z.infer<typeof stepInput>;

/** The message for the first thing wrong with a body, in the owner's words. */
function inputError(issue: { code: string; path: readonly PropertyKey[] } | undefined): ApiError {
  const [root, , key] = issue?.path ?? [];
  if (root === 'steps' && issue?.path.length === 1 && issue.code === 'too_big') {
    return new ApiError(400, `В скрипте не больше ${SCRIPT_STEP_LIMIT} шагов`);
  }
  switch (key) {
    case 'title':
      return issue?.code === 'too_big'
        ? new ApiError(400, `Название шага длиннее ${SCRIPT_TITLE_MAX} символов`)
        : new ApiError(400, 'Укажите название шага');
    case 'condition': return new ApiError(400, `Условие ветки длиннее ${SCRIPT_CONDITION_MAX} символов`);
    case 'instructions': return new ApiError(400, `Текст шага длиннее ${SCRIPT_INSTRUCTIONS_MAX} символов`);
    case 'handoffNote': return new ApiError(400, `Заметка для сотрудника длиннее ${SCRIPT_HANDOFF_NOTE_MAX} символов`);
    case 'photoIds': return new ApiError(400, `У шага не больше ${SCRIPT_STEP_PHOTOS} фото`);
    case 'fieldIds': return new ApiError(400, `У шага не больше ${SCRIPT_STEP_FIELDS} полей`);
    default: return new ApiError(400, 'Не удалось разобрать скрипт');
  }
}

/**
 * Everything about a save that needs more than one step, or the database, to check.
 *
 * Every id is checked against this agent: a photo, a field or a stage of another agent named
 * in a step would be sent to — or asked of — this agent's customers.
 */
async function validate(tx: Executor, agentId: string, steps: readonly StepInput[]): Promise<void> {
  const ids = new Set<string>();
  for (const step of steps) {
    if (ids.has(step.id)) throw new ApiError(400, 'Два шага с одним id');
    ids.add(step.id);
  }
  const byId = new Map(steps.map((step) => [step.id, step]));
  for (const step of steps) {
    if (step.parentId === null) continue;
    const parent = byId.get(step.parentId);
    if (!parent || parent.id === step.id) throw new ApiError(400, `Ветка «${step.title}» ссылается на шаг, которого нет`);
    // Depth two, which also rules out every cycle: a parent is always a main-chain step.
    if (parent.parentId !== null) throw new ApiError(400, `У ветки «${parent.title}» не может быть своих веток`);
  }

  const photoIds = [...new Set(steps.flatMap((step) => step.photoIds))];
  if (steps.some((step) => new Set(step.photoIds).size !== step.photoIds.length)) {
    throw new ApiError(400, 'Одно фото выбрано у шага дважды');
  }
  if (photoIds.length > 0) {
    const known = await tx.select({ id: productPhotos.id }).from(productPhotos)
      .innerJoin(products, eq(products.id, productPhotos.productId))
      .where(and(eq(products.agentId, agentId), inArray(productPhotos.id, photoIds)));
    if (known.length !== photoIds.length) throw new ApiError(400, 'Фото нет в каталоге этого агента');
  }
  const fieldIds = [...new Set(steps.flatMap((step) => step.fieldIds))];
  if (fieldIds.length > 0) {
    const known = await tx.select({ id: leadFields.id }).from(leadFields)
      .where(and(eq(leadFields.agentId, agentId), inArray(leadFields.id, fieldIds)));
    if (known.length !== fieldIds.length) throw new ApiError(400, 'Поля нет у этого агента');
  }
  const stageIds = [...new Set(steps.flatMap((step) => (step.stageId === null ? [] : [step.stageId])))];
  if (stageIds.length > 0) {
    const known = await tx.select({ id: stages.id }).from(stages)
      .where(and(eq(stages.agentId, agentId), inArray(stages.id, stageIds)));
    if (known.length !== stageIds.length) throw new ApiError(400, 'Этапа нет в воронке этого агента');
  }
}

export function registerSalesScriptRoutes(app: FastifyInstance, db: Db, guard: preHandlerHookHandler): void {
  const anyMember = requireAgent(db);
  const ownerOnly = requireAgent(db, { role: 'owner' });
  const path = '/api/agents/:agentId/script';

  // Any member reads it: an operator taking over a conversation needs to know which step the
  // agent was following. Only the owner changes what the agent does.
  app.get(path, { preHandler: [guard, anyMember] }, async (req): Promise<SalesScript> => {
    const rows = await loadScript(db, req.agent!.id);
    return { steps: rows.map(toScriptStep) };
  });

  /**
   * Replaces the whole script in one transaction.
   *
   * The editor saves the tree as a whole because a move, a new branch and a deleted step are
   * one edit to the owner, and applying them one request at a time would leave a half-moved
   * chain live for the turns in between. Existing ids are kept, so a conversation standing on
   * a step is still on it after the save; a step the list no longer names is deleted, and the
   * conversations on it pick a step again on their next reply.
   */
  app.put(path, { preHandler: [guard, ownerOnly] }, async (req): Promise<SalesScript> => {
    const parsed = saveBody.safeParse(req.body);
    if (!parsed.success) throw inputError(parsed.error.issues[0]);
    const steps = parsed.data.steps.map((step) =>
      // A condition is what makes a branch a branch; on a main-chain step it would be read by
      // nobody, and kept it would reappear the moment the step became a branch.
      (step.parentId === null ? { ...step, condition: '' } : step));
    const agentId = req.agent!.id;

    await db.transaction(async (tx) => {
      // Serialises two saves of one agent's script; `no key update` for the reason
      // `api/stages.ts` gives — it does not block the inserts that reference the agent.
      await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, agentId)).for('no key update');
      await validate(tx, agentId, steps);

      const existing = new Set((await tx.select({ id: salesScriptSteps.id }).from(salesScriptSteps)
        .where(eq(salesScriptSteps.agentId, agentId))).map((row) => row.id));
      for (const step of steps) {
        if (!TMP_ID.test(step.id) && !existing.has(step.id)) {
          throw new ApiError(409, 'Скрипт уже изменили. Обновите страницу и повторите');
        }
      }

      const realId = new Map(steps.map((step) => [step.id, TMP_ID.test(step.id) ? randomUUID() : step.id]));
      const kept = steps.filter((step) => existing.has(step.id)).map((step) => step.id);
      // Detached first: `parent_id` cascades, so deleting a removed main step while a kept
      // branch still pointed at it would take the branch — which this save moves elsewhere —
      // down with it.
      if (kept.length > 0) {
        await tx.update(salesScriptSteps).set({ parentId: null })
          .where(and(eq(salesScriptSteps.agentId, agentId), isNotNull(salesScriptSteps.parentId)));
      }
      const removed = [...existing].filter((id) => !kept.includes(id));
      if (removed.length > 0) {
        await tx.delete(salesScriptSteps)
          .where(and(eq(salesScriptSteps.agentId, agentId), inArray(salesScriptSteps.id, removed)));
      }

      const siblings = new Map<string | null, number>();
      const now = new Date();
      // Parents before children, so every `parent_id` written already exists.
      for (const step of [...steps].sort((a, b) => Number(a.parentId !== null) - Number(b.parentId !== null))) {
        const position = siblings.get(step.parentId) ?? 0;
        siblings.set(step.parentId, position + 1);
        const values = {
          parentId: step.parentId === null ? null : realId.get(step.parentId)!,
          position,
          title: step.title,
          condition: step.condition,
          instructions: step.instructions,
          stageId: step.stageId,
          photoIds: step.photoIds,
          fieldIds: step.fieldIds,
          handoff: step.handoff,
          handoffNote: step.handoffNote,
          waitPayment: step.waitPayment,
          updatedAt: now,
        };
        if (existing.has(step.id)) {
          await tx.update(salesScriptSteps).set(values).where(eq(salesScriptSteps.id, step.id));
        } else {
          await tx.insert(salesScriptSteps).values({ ...values, id: realId.get(step.id)!, agentId });
        }
      }
      await bumpConfigVersion(tx as unknown as Db, agentId);
    });

    const rows = await loadScript(db, agentId);
    return { steps: rows.map(toScriptStep) };
  });
}
