import type { Promotion } from '@rakurs/contract';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { products, productVariants, promotionItems, promotions } from '../../db/schema.js';

/**
 * Promotions («акции»): promotional prices for catalog variants, one preset in effect at a time.
 *
 * «In effect» is `active and (ends_at is null or ends_at > now())`, evaluated by the database
 * clock on every read, so no job has to be awake when a promotion ends.
 *
 * An expiry is still a change to what the agent answers, and everything that reuses an answer
 * — the «было» baseline, a draft's apply gate — is keyed on `config_version`. A date passing
 * bumps nothing by itself, so `settleExpiredPromotions` turns that moment into an ordinary
 * write: the first agent request or turn that sees an expired active row switches it off and
 * bumps the version in one statement. Until then nothing can reuse a stale answer, because
 * nothing keyed on the version runs without passing through one of those two places first.
 */

/** Promotions a preset list stops at: a shop prepares a handful, not a price history. */
export const PROMOTIONS_PER_AGENT = 50;

/** The SQL for «in effect now», shared by every reader so none of them drifts. */
export const promotionEffective = sql<boolean>`(${promotions.active} and (${promotions.endsAt} is null or ${promotions.endsAt} > now()))`;

/**
 * Switches off this agent's active promotion if its end date has passed, bumping
 * `config_version` in the same statement. Answers the new version, or null when nothing had
 * expired — the common case, and then one indexed update that matches no row.
 *
 * One statement rather than a transaction, because it runs on every agent request: a
 * data-modifying CTE is atomic on its own, and saves the BEGIN and COMMIT round trips. Guarded
 * by the condition it acts on, so two requests racing past the moment bump once: the second
 * update re-reads the row after the first commits and finds it inactive.
 */
export async function settleExpiredPromotions(db: Db, agentId: string): Promise<number | null> {
  const result = await db.execute(sql`
    with expired as (
      update promotions set active = false, updated_at = now()
      where agent_id = ${agentId} and active and ends_at is not null and ends_at <= now()
      returning id
    )
    update agents set config_version = config_version + 1
    where id = ${agentId} and exists (select 1 from expired)
    returning config_version`);
  const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? []);
  const row = rows[0] as { config_version: number } | undefined;
  return row === undefined ? null : Number(row.config_version);
}

/** Every promotion of the agent in the owner's order, with its items as the catalog has them now. */
export async function loadPromotions(
  db: Db,
  agentId: string,
  options: { promotionIds?: string[] } = {},
): Promise<Promotion[]> {
  const conditions = [eq(promotions.agentId, agentId)];
  if (options.promotionIds) {
    if (options.promotionIds.length === 0) return [];
    conditions.push(inArray(promotions.id, options.promotionIds));
  }
  const rows = await db.select({ promotion: promotions, effective: promotionEffective }).from(promotions)
    .where(and(...conditions)).orderBy(asc(promotions.position), asc(promotions.createdAt));
  if (rows.length === 0) return [];

  const items = await db.select({
    promotionId: promotionItems.promotionId,
    variantId: promotionItems.variantId,
    promoPrice: promotionItems.promoPrice,
    productId: products.id,
    productName: products.name,
    variantLabel: productVariants.label,
    regularPrice: productVariants.price,
  }).from(promotionItems)
    .innerJoin(productVariants, eq(productVariants.id, promotionItems.variantId))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(inArray(promotionItems.promotionId, rows.map((row) => row.promotion.id)))
    .orderBy(asc(products.position), asc(products.createdAt), asc(productVariants.position));

  return rows.map(({ promotion, effective }) => ({
    id: promotion.id,
    name: promotion.name,
    description: promotion.description,
    active: promotion.active,
    endsAt: promotion.endsAt?.toISOString() ?? null,
    effective,
    position: promotion.position,
    items: items.filter((item) => item.promotionId === promotion.id)
      .map(({ promotionId: _, ...item }) => item),
    createdAt: promotion.createdAt.toISOString(),
    updatedAt: promotion.updatedAt.toISOString(),
  }));
}

/** The promotion a turn quotes, or null: effective, with its prices keyed by variant id. */
export interface EffectivePromotion {
  name: string;
  description: string;
  endsAt: Date | null;
  prices: Map<string, number>;
}

export async function loadEffectivePromotion(db: Db, agentId: string): Promise<EffectivePromotion | null> {
  const [row] = await db.select().from(promotions)
    .where(and(eq(promotions.agentId, agentId), promotionEffective)).limit(1);
  if (!row) return null;
  const items = await db.select({ variantId: promotionItems.variantId, promoPrice: promotionItems.promoPrice })
    .from(promotionItems).where(eq(promotionItems.promotionId, row.id));
  return {
    name: row.name,
    description: row.description,
    endsAt: row.endsAt,
    prices: new Map(items.map((item) => [item.variantId, item.promoPrice])),
  };
}
