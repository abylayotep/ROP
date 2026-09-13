import type { Promotion } from '@rakurs/contract';
import { and, count, eq, inArray, max, ne, sql } from 'drizzle-orm';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { agents, products, productVariants, promotionItems, promotions } from '../db/schema.js';
import { loadPromotions, PROMOTIONS_PER_AGENT } from '../lib/catalog/promotions.js';
import { bumpConfigVersion } from '../lib/drafts/version.js';
import { ApiError } from '../lib/errors.js';
import { isUuid } from '../lib/uuid.js';
import { requireAgent } from './require-agent.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const NAME_MAX = 120;
const DESCRIPTION_MAX = 2_000;
/** Every variant of a good-sized catalog; more is a price list, not a promotion. */
const ITEMS_MAX = 200;
/** The same ceiling a catalog price has. */
const PRICE_MAX = 1_000_000_000;

const savePromotion = z.object({
  name: z.string().trim().min(1).max(NAME_MAX),
  description: z.string().trim().max(DESCRIPTION_MAX).optional(),
  endsAt: z.string().datetime({ offset: true }).nullable().optional(),
  items: z.array(z.object({
    variantId: z.string(),
    promoPrice: z.number().int().min(0).max(PRICE_MAX),
  })).max(ITEMS_MAX),
});

/** The message for the field that failed, so a 400 names what to fix. */
function promotionError(issue: { code: string; path: readonly PropertyKey[] } | undefined): ApiError {
  const field = issue?.path[0];
  if (field === 'name') {
    return issue?.code === 'too_big'
      ? new ApiError(400, `Название длиннее ${NAME_MAX} символов`)
      : new ApiError(400, 'Укажите название акции');
  }
  if (field === 'description') return new ApiError(400, `Описание длиннее ${DESCRIPTION_MAX} символов`);
  if (field === 'endsAt') return new ApiError(400, 'Не удалось разобрать дату окончания');
  if (field === 'items') {
    if (issue?.path.length === 1) {
      return issue?.code === 'too_big'
        ? new ApiError(400, `Не больше ${ITEMS_MAX} позиций в акции`)
        : new ApiError(400, 'Не удалось разобрать товары акции');
    }
    return issue?.path[2] === 'promoPrice'
      ? new ApiError(400, 'Цена по акции должна быть целым числом от 0')
      : new ApiError(400, 'Вариант товара не найден');
  }
  return new ApiError(400, 'Не удалось разобрать акцию');
}

/**
 * The promotion routes. Members read — the people answering customers need to know which
 * price the agent is quoting today — and only the owner changes them, like the catalog they
 * price. Every write bumps `configVersion` in its own transaction, activation and deactivation
 * included: the promotion in effect is in the prompt.
 *
 * Expiry needs no route: `requireAgent` switches off an expired promotion before any of these
 * handlers runs, so a list read here is already settled.
 */
export function registerPromotionRoutes(app: FastifyInstance, db: Db, guard: preHandlerHookHandler): void {
  const anyMember = requireAgent(db);
  const ownerOnly = requireAgent(db, { role: 'owner' });
  const base = '/api/agents/:agentId/promotions';

  /** This agent's promotion row, locked, or 404. */
  async function ownPromotion(tx: Tx, agentId: string, promotionId: string) {
    if (!isUuid(promotionId)) throw new ApiError(404, 'Акция не найдена');
    const [row] = await tx.select().from(promotions)
      .where(and(eq(promotions.id, promotionId), eq(promotions.agentId, agentId))).for('update');
    if (!row) throw new ApiError(404, 'Акция не найдена');
    return row;
  }

  async function promotionById(agentId: string, promotionId: string): Promise<Promotion> {
    const [promotion] = await loadPromotions(db, agentId, { promotionIds: [promotionId] });
    if (!promotion) throw new ApiError(404, 'Акция не найдена');
    return promotion;
  }

  /** The body, checked against this agent's catalog: a variant of anyone else's is refused. */
  async function readBody(tx: Tx, agentId: string, body: unknown, stored: Date | null | undefined) {
    const parsed = savePromotion.safeParse(body);
    if (!parsed.success) throw promotionError(parsed.error.issues[0]);
    const { items } = parsed.data;

    const endsAt = parsed.data.endsAt === undefined || parsed.data.endsAt === null
      ? null : new Date(parsed.data.endsAt);
    // A date already behind us would make the promotion expired on arrival. Refused only when
    // the owner set it now: an expired promotion keeps its old date through a rename.
    const unchanged = endsAt !== null && stored?.getTime() === endsAt.getTime();
    if (endsAt !== null && !unchanged && endsAt.getTime() <= Date.now()) {
      throw new ApiError(400, 'Дата окончания уже прошла');
    }

    const ids = items.map((item) => item.variantId);
    if (new Set(ids).size !== ids.length) throw new ApiError(400, 'Вариант указан в акции дважды');
    if (ids.some((id) => !isUuid(id))) throw new ApiError(400, 'Вариант товара не найден');
    if (ids.length > 0) {
      const [found] = await tx.select({ n: count() }).from(productVariants)
        .innerJoin(products, eq(products.id, productVariants.productId))
        .where(and(inArray(productVariants.id, ids), eq(products.agentId, agentId)));
      if ((found?.n ?? 0) !== ids.length) throw new ApiError(400, 'Вариант товара не найден');
    }
    return { name: parsed.data.name, description: parsed.data.description ?? '', endsAt, items };
  }

  async function writeItems(tx: Tx, promotionId: string, items: { variantId: string; promoPrice: number }[]) {
    await tx.delete(promotionItems).where(eq(promotionItems.promotionId, promotionId));
    if (items.length === 0) return;
    await tx.insert(promotionItems).values(items.map((item) => ({ promotionId, ...item })));
  }

  app.get(base, { preHandler: [guard, anyMember] }, async (req): Promise<Promotion[]> =>
    loadPromotions(db, req.agent!.id));

  app.post(base, { preHandler: [guard, ownerOnly] }, async (req, reply): Promise<Promotion> => {
    const agentId = req.agent!.id;
    const id = await db.transaction(async (tx) => {
      // First, so the agent row is locked before the count: two creates cannot both see 49.
      await bumpConfigVersion(tx as unknown as Db, agentId);
      const body = await readBody(tx, agentId, req.body, undefined);
      const [taken] = await tx.select({ n: count(), last: max(promotions.position) }).from(promotions)
        .where(eq(promotions.agentId, agentId));
      if ((taken?.n ?? 0) >= PROMOTIONS_PER_AGENT) {
        throw new ApiError(409, `Не больше ${PROMOTIONS_PER_AGENT} акций у агента. Удалите ненужные.`);
      }
      const [created] = await tx.insert(promotions).values({
        agentId, name: body.name, description: body.description, endsAt: body.endsAt,
        position: (taken?.last ?? -1) + 1,
      }).returning({ id: promotions.id });
      await writeItems(tx, created!.id, body.items);
      return created!.id;
    });
    reply.code(201);
    return promotionById(agentId, id);
  });

  app.put(`${base}/:promotionId`, { preHandler: [guard, ownerOnly] }, async (req): Promise<Promotion> => {
    const { promotionId } = req.params as { promotionId: string };
    const agentId = req.agent!.id;
    await db.transaction(async (tx) => {
      const row = await ownPromotion(tx, agentId, promotionId);
      const body = await readBody(tx, agentId, req.body, row.endsAt);
      await tx.update(promotions).set({
        name: body.name, description: body.description, endsAt: body.endsAt, updatedAt: sql`now()`,
      }).where(eq(promotions.id, promotionId));
      await writeItems(tx, promotionId, body.items);
      await bumpConfigVersion(tx as unknown as Db, agentId);
    });
    return promotionById(agentId, promotionId);
  });

  app.delete(`${base}/:promotionId`, { preHandler: [guard, ownerOnly] }, async (req): Promise<{ ok: true }> => {
    const { promotionId } = req.params as { promotionId: string };
    const agentId = req.agent!.id;
    await db.transaction(async (tx) => {
      await ownPromotion(tx, agentId, promotionId);
      await tx.delete(promotions).where(eq(promotions.id, promotionId));
      await bumpConfigVersion(tx as unknown as Db, agentId);
    });
    return { ok: true };
  });

  app.post(`${base}/:promotionId/activate`, { preHandler: [guard, ownerOnly] }, async (req): Promise<Promotion> => {
    const { promotionId } = req.params as { promotionId: string };
    const agentId = req.agent!.id;
    await db.transaction(async (tx) => {
      // The agent row first: two owners switching on two different promotions at once queue
      // here, so the second sees the first one active and switches it off, instead of both
      // switching nothing off and one of them tripping the one-active index.
      const [locked] = await tx.select({ id: agents.id }).from(agents)
        .where(eq(agents.id, agentId)).for('update');
      if (!locked) throw new ApiError(404, 'Агент не найден');
      const row = await ownPromotion(tx, agentId, promotionId);
      if (row.endsAt !== null && row.endsAt.getTime() <= Date.now()) {
        throw new ApiError(409, 'Срок акции истёк. Измените дату окончания, чтобы включить её.');
      }
      const [items] = await tx.select({ n: count() }).from(promotionItems)
        .where(eq(promotionItems.promotionId, promotionId));
      if ((items?.n ?? 0) === 0) throw new ApiError(409, 'В акции нет ни одного товара. Добавьте цены по акции.');
      // Already on: nothing the agent says would change, so no version either.
      if (row.active) return;
      await tx.update(promotions).set({ active: false, updatedAt: sql`now()` })
        .where(and(eq(promotions.agentId, agentId), eq(promotions.active, true), ne(promotions.id, promotionId)));
      await tx.update(promotions).set({ active: true, updatedAt: sql`now()` }).where(eq(promotions.id, promotionId));
      await bumpConfigVersion(tx as unknown as Db, agentId);
    });
    return promotionById(agentId, promotionId);
  });

  app.post(`${base}/:promotionId/deactivate`, { preHandler: [guard, ownerOnly] }, async (req): Promise<Promotion> => {
    const { promotionId } = req.params as { promotionId: string };
    const agentId = req.agent!.id;
    await db.transaction(async (tx) => {
      const row = await ownPromotion(tx, agentId, promotionId);
      if (!row.active) return;
      await tx.update(promotions).set({ active: false, updatedAt: sql`now()` }).where(eq(promotions.id, promotionId));
      await bumpConfigVersion(tx as unknown as Db, agentId);
    });
    return promotionById(agentId, promotionId);
  });
}
