### Task 3: Stages and lead fields over the API

**Files:**
- Create: `server/src/api/stages.ts`
- Modify: `server/src/api/server.ts` (register the routes)
- Modify: `packages/contract/index.ts` (nothing new — task 2 added `Stage` and `LeadField`)
- Create: `server/test/stages-api.test.ts` (its contents are in [task-3-stages-test.md](2026-09-03-orders-task-3-stages-test.md))

**Interfaces:**
- Consumes: `requireAgent` from `server/src/api/require-agent.ts`, `ApiError` from `server/src/lib/errors.ts`, `isUuid` from `server/src/lib/uuid.ts`, `stages` / `leadFields` / `conversations` from the schema, the contract types `Stage` and `LeadField`.
- Produces: `registerStageRoutes(app, db, guard)` and these routes:
  - `GET /api/agents/:agentId/stages` → `Stage[]`, any member
  - `POST /api/agents/:agentId/stages` → `Stage`, owner
  - `PATCH /api/agents/:agentId/stages/:stageId` → `Stage`, owner
  - `DELETE /api/agents/:agentId/stages/:stageId` → `{ ok: true }`, owner
  - `POST /api/agents/:agentId/stages/order` → `Stage[]`, owner
  - `GET /api/agents/:agentId/lead-fields` → `LeadField[]`, any member
  - `POST /api/agents/:agentId/lead-fields` → `LeadField`, owner
  - `PATCH /api/agents/:agentId/lead-fields/:fieldId` → `LeadField`, owner
  - `DELETE /api/agents/:agentId/lead-fields/:fieldId` → `{ ok: true }`, owner

**Context.** Task 2 seeds a funnel. This makes it the client's: renamed, recoloured, reordered, extended. Two rules are the reason this is a task rather than plain CRUD — an agent has exactly one sale stage, and a stage still holding conversations cannot be deleted.

**Moving the sale.** Marking a stage as `success`, on create or on patch, demotes whichever stage held that role to `active`, in one transaction. Demoting the only sale stage is refused, and so is deleting it. Refusing the promotion too would make the sale stage immovable, which is a funnel an owner cannot rename.

**Ordering.** Both tables carry an integer `position`. New rows go to the end (`max + 1`). The reorder route takes the full list of ids and rewrites every position from its index, which is the only form that cannot leave two rows sharing a place.

- [ ] **Step 1: Write the failing test**

The test is long enough to live in its own document:
[task-3-stages-test.md](2026-09-03-orders-task-3-stages-test.md). Create
`server/test/stages-api.test.ts` with exactly the contents given there.

- [ ] **Step 2: Run it and watch it fail**

```bash
npm --prefix server test -- stages-api
```

Expected: every case fails with 404 — no route is registered yet.

- [ ] **Step 3: Write the routes**

Create `server/src/api/stages.ts`:

```ts
import type { LeadField, Stage } from '@rakurs/contract';
import { and, asc, count, eq, ne } from 'drizzle-orm';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { conversations, leadFields, stages } from '../db/schema.js';
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

export function registerStageRoutes(
  app: FastifyInstance,
  db: Db,
  guard: preHandlerHookHandler,
): void {
  const anyMember = requireAgent(db);
  const ownerOnly = requireAgent(db, { role: 'owner' });

  const listStages = (agentId: string) =>
    db.select().from(stages).where(eq(stages.agentId, agentId)).orderBy(asc(stages.position));

  /** The agent's stage, or a 404 that tells a stranger nothing. */
  async function loadStage(agentId: string, stageId: string) {
    if (!isUuid(stageId)) throw new ApiError(404, 'Стадия не найдена');
    const [row] = await db
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

      const existing = await listStages(req.agent!.id);
      const row = await db.transaction(async (tx) => {
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
      const current = await loadStage(req.agent!.id, stageId);

      const parsed = patchStage.safeParse(req.body);
      if (!parsed.success) throw new ApiError(400, 'Не удалось разобрать стадию');
      if (Object.keys(parsed.data).length === 0) return toStage(current);

      if (
        parsed.data.kind !== undefined &&
        parsed.data.kind !== current.kind &&
        current.kind === 'success'
      ) {
        // Refused rather than allowed and warned about: with no sale stage the board still
        // works, but every number stage 6 and stage 7 report becomes a zero. The way to move
        // the sale is to promote another stage, which demotes this one.
        throw new ApiError(
          409,
          'У воронки должна быть стадия продажи. Сначала назначьте продажей другую стадию.',
        );
      }

      const row = await db.transaction(async (tx) => {
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
      const current = await loadStage(req.agent!.id, stageId);

      if (current.kind === 'success') {
        throw new ApiError(409, 'Это стадия продажи. Назначьте продажей другую и повторите.');
      }

      // Deleting would set every conversation's stage to null and silently empty a
      // column of the board. Refused with the number, so the owner knows what is at stake.
      const [holders] = await db
        .select({ held: count() })
        .from(conversations)
        .where(eq(conversations.stageId, current.id));
      const held = holders?.held ?? 0;
      if (held > 0) {
        throw new ApiError(
          409,
          `В стадии ${held} диалогов. Перенесите их в другую стадию и повторите.`,
        );
      }

      await db.delete(stages).where(eq(stages.id, current.id));
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
          await tx.update(stages).set({ position }).where(eq(stages.id, id));
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
}
```

- [ ] **Step 4: Register the routes**

In `server/src/api/server.ts`, add the import and the registration line after
`registerConversationRoutes(...)`:

```ts
import { registerStageRoutes } from './stages.js';
```

```ts
  registerStageRoutes(app, db, guard);
```

- [ ] **Step 5: Run the tests**

```bash
npm --prefix server test
npm --prefix server run typecheck
```

Expected: green, including the twenty-one files that were already there.

- [ ] **Step 6: Commit**

```bash
git add server/src/api/stages.ts server/src/api/server.ts server/test/stages-api.test.ts
git commit -m "Let an owner shape the funnel and the lead fields"
```
