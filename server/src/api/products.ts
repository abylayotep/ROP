import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Product } from '@rakurs/contract';
import { and, count, eq, max, sql } from 'drizzle-orm';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { productPhotos, products, productVariants } from '../db/schema.js';
import type { Env } from '../env.js';
import {
  loadProducts,
  PHOTO_MAX_BYTES,
  PHOTOS_PER_PRODUCT,
  removeStoredFiles,
  sniffImage,
  storeProductPhoto,
  VARIANTS_PER_PRODUCT,
} from '../lib/catalog/products.js';
import { bumpConfigVersion } from '../lib/drafts/version.js';
import { ApiError } from '../lib/errors.js';
import { isUuid } from '../lib/uuid.js';
import { requireAgent } from './require-agent.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const NAME_MAX = 120;
/** Long enough for a paragraph of specs; the prompt shows less and says so. */
const DESCRIPTION_MAX = 4_000;
const LABEL_MAX = 60;
const CAPTION_MAX = 200;
/** A billion tenge is not a door. Also keeps the value inside Postgres `integer`. */
const PRICE_MAX = 1_000_000_000;

const variantInput = z.object({
  label: z.string().trim().max(LABEL_MAX),
  price: z.number().int().min(0).max(PRICE_MAX),
});
const variantList = z.array(variantInput).max(VARIANTS_PER_PRODUCT);

const createProduct = z.object({
  name: z.string().trim().min(1).max(NAME_MAX),
  description: z.string().trim().max(DESCRIPTION_MAX).optional(),
  active: z.boolean().optional(),
  variants: variantList.optional(),
});
const updateProduct = z.object({
  name: z.string().trim().min(1).max(NAME_MAX).optional(),
  description: z.string().trim().max(DESCRIPTION_MAX).optional(),
  active: z.boolean().optional(),
});
const replaceVariants = z.object({ variants: variantList });
const photoOrder = z.object({ photoIds: z.array(z.string()).max(PHOTOS_PER_PRODUCT) });
const photoUpdate = z.object({ caption: z.string().trim().max(CAPTION_MAX) });

/** The message for the field that failed, so a 400 names what to fix. */
function productError(issue: { code: string; path: readonly PropertyKey[] } | undefined): ApiError {
  const field = issue?.path[0];
  if (field === 'name') {
    return issue?.code === 'too_big'
      ? new ApiError(400, `Название длиннее ${NAME_MAX} символов`)
      : new ApiError(400, 'Укажите название товара');
  }
  if (field === 'description') return new ApiError(400, `Описание длиннее ${DESCRIPTION_MAX} символов`);
  if (field === 'variants') {
    if (issue?.path.length === 1) return new ApiError(400, `Не больше ${VARIANTS_PER_PRODUCT} вариантов у товара`);
    return issue?.path[2] === 'label'
      ? new ApiError(400, `Название варианта длиннее ${LABEL_MAX} символов`)
      : new ApiError(400, 'Цена должна быть целым числом от 0');
  }
  return new ApiError(400, 'Не удалось разобрать товар');
}

const mb = (bytes: number) => Math.round(bytes / 1024 / 1024);

/**
 * The catalog routes. Any member reads it — the people answering customers need to see the
 * prices the agent quotes — and only the owner changes it, because a price is a promise the
 * business makes. Every write bumps `configVersion` in its own transaction: the catalog is
 * in the prompt, so a changed price is a changed answer.
 */
export function registerProductRoutes(
  app: FastifyInstance,
  db: Db,
  env: Env,
  guard: preHandlerHookHandler,
): void {
  const anyMember = requireAgent(db);
  const ownerOnly = requireAgent(db, { role: 'owner' });
  const base = '/api/agents/:agentId/products';

  /** This agent's product row, locked when a transaction is given, or 404. */
  async function ownProduct(agentId: string, productId: string, tx?: Tx) {
    if (!isUuid(productId)) throw new ApiError(404, 'Товар не найден');
    const query = (tx ?? db).select().from(products)
      .where(and(eq(products.id, productId), eq(products.agentId, agentId)));
    // Locked so two uploads cannot both count nine photos and both add a tenth.
    const [row] = tx ? await query.for('update') : await query;
    if (!row) throw new ApiError(404, 'Товар не найден');
    return row;
  }

  async function productById(agentId: string, productId: string): Promise<Product> {
    const [product] = await loadProducts(db, agentId, { productIds: [productId] });
    if (!product) throw new ApiError(404, 'Товар не найден');
    return product;
  }

  async function writeVariants(tx: Tx, productId: string, variants: z.infer<typeof variantList>) {
    await tx.delete(productVariants).where(eq(productVariants.productId, productId));
    if (variants.length === 0) return;
    await tx.insert(productVariants).values(variants.map((variant, position) => ({
      productId, label: variant.label, price: variant.price, position,
    })));
  }

  const touch = (tx: Tx, productId: string) =>
    tx.update(products).set({ updatedAt: sql`now()` }).where(eq(products.id, productId));

  app.get(base, { preHandler: [guard, anyMember] }, async (req): Promise<Product[]> =>
    loadProducts(db, req.agent!.id));

  app.post(base, { preHandler: [guard, ownerOnly] }, async (req, reply): Promise<Product> => {
    const parsed = createProduct.safeParse(req.body);
    if (!parsed.success) throw productError(parsed.error.issues[0]);
    const agentId = req.agent!.id;

    const id = await db.transaction(async (tx) => {
      const [last] = await tx.select({ position: max(products.position) }).from(products)
        .where(eq(products.agentId, agentId));
      const [created] = await tx.insert(products).values({
        agentId,
        name: parsed.data.name,
        description: parsed.data.description ?? '',
        active: parsed.data.active ?? true,
        position: (last?.position ?? -1) + 1,
      }).returning({ id: products.id });
      await writeVariants(tx, created!.id, parsed.data.variants ?? []);
      await bumpConfigVersion(tx as unknown as Db, agentId);
      return created!.id;
    });
    reply.code(201);
    return productById(agentId, id);
  });

  app.patch(`${base}/:productId`, { preHandler: [guard, ownerOnly] }, async (req): Promise<Product> => {
    const { productId } = req.params as { productId: string };
    const parsed = updateProduct.safeParse(req.body);
    if (!parsed.success) throw productError(parsed.error.issues[0]);
    const agentId = req.agent!.id;

    await db.transaction(async (tx) => {
      await ownProduct(agentId, productId, tx);
      await tx.update(products).set({ ...parsed.data, updatedAt: sql`now()` }).where(eq(products.id, productId));
      await bumpConfigVersion(tx as unknown as Db, agentId);
    });
    return productById(agentId, productId);
  });

  app.delete(`${base}/:productId`, { preHandler: [guard, ownerOnly] }, async (req): Promise<{ ok: true }> => {
    const { productId } = req.params as { productId: string };
    const agentId = req.agent!.id;

    const paths = await db.transaction(async (tx) => {
      await ownProduct(agentId, productId, tx);
      const photos = await tx.select({ path: productPhotos.mediaPath }).from(productPhotos)
        .where(eq(productPhotos.productId, productId));
      await tx.delete(products).where(eq(products.id, productId));
      await bumpConfigVersion(tx as unknown as Db, agentId);
      return photos.map((photo) => photo.path);
    });
    // After the commit: a rolled-back delete must still find its photos on disk.
    await removeStoredFiles(env.MEDIA_DIR, paths);
    return { ok: true };
  });

  app.put(`${base}/:productId/variants`, { preHandler: [guard, ownerOnly] }, async (req): Promise<Product> => {
    const { productId } = req.params as { productId: string };
    const parsed = replaceVariants.safeParse(req.body);
    if (!parsed.success) throw productError(parsed.error.issues[0]);
    const agentId = req.agent!.id;

    await db.transaction(async (tx) => {
      await ownProduct(agentId, productId, tx);
      await writeVariants(tx, productId, parsed.data.variants);
      await touch(tx, productId);
      await bumpConfigVersion(tx as unknown as Db, agentId);
    });
    return productById(agentId, productId);
  });

  app.post(`${base}/:productId/photos`, { preHandler: [guard, ownerOnly] }, async (req, reply): Promise<Product> => {
    const { productId } = req.params as { productId: string };
    const agentId = req.agent!.id;
    await ownProduct(agentId, productId);

    const file = await req.file({ limits: { fileSize: PHOTO_MAX_BYTES } });
    if (!file) throw new ApiError(400, 'Файл не выбран');
    const tooBig = () => new ApiError(413, `Фото больше ${mb(PHOTO_MAX_BYTES)} МБ.`);
    const bytes = await file.toBuffer().catch(() => { throw tooBig(); });
    if (file.file.truncated) throw tooBig();
    const mime = sniffImage(bytes);
    if (!mime) throw new ApiError(415, 'Подойдут только фото JPEG, PNG или WebP.');
    const rawCaption = (file.fields?.caption as { value?: string } | undefined)?.value?.trim() ?? '';
    const caption = rawCaption.slice(0, CAPTION_MAX);

    const photoId = randomUUID();
    let stored: string | null = null;
    try {
      await db.transaction(async (tx) => {
        await ownProduct(agentId, productId, tx);
        const [taken] = await tx.select({ n: count(), last: max(productPhotos.position) }).from(productPhotos)
          .where(eq(productPhotos.productId, productId));
        if ((taken?.n ?? 0) >= PHOTOS_PER_PRODUCT) {
          throw new ApiError(409, `У товара уже ${PHOTOS_PER_PRODUCT} фото. Удалите лишнее, чтобы добавить новое.`);
        }
        stored = await storeProductPhoto(env.MEDIA_DIR, { agentId, photoId, bytes, mime });
        await tx.insert(productPhotos).values({
          id: photoId,
          productId,
          mediaPath: stored,
          mediaMime: mime,
          sizeBytes: bytes.byteLength,
          filename: (file.filename ?? '').slice(0, 200),
          caption: caption === '' ? null : caption,
          position: (taken?.last ?? -1) + 1,
        });
        await touch(tx, productId);
        await bumpConfigVersion(tx as unknown as Db, agentId);
      });
    } catch (error) {
      if (stored !== null) await removeStoredFiles(env.MEDIA_DIR, [stored]);
      throw error;
    }
    reply.code(201);
    return productById(agentId, productId);
  });

  /** One photo of one of this agent's products, or 404. */
  async function ownPhoto(agentId: string, productId: string, photoId: string, tx?: Tx) {
    await ownProduct(agentId, productId, tx);
    if (!isUuid(photoId)) throw new ApiError(404, 'Фото не найдено');
    const [photo] = await (tx ?? db).select().from(productPhotos)
      .where(and(eq(productPhotos.id, photoId), eq(productPhotos.productId, productId)));
    if (!photo) throw new ApiError(404, 'Фото не найдено');
    return photo;
  }

  app.patch(`${base}/:productId/photos/:photoId`, { preHandler: [guard, ownerOnly] }, async (req): Promise<Product> => {
    const { productId, photoId } = req.params as { productId: string; photoId: string };
    const parsed = photoUpdate.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, `Подпись длиннее ${CAPTION_MAX} символов`);
    const agentId = req.agent!.id;

    await db.transaction(async (tx) => {
      await ownPhoto(agentId, productId, photoId, tx);
      await tx.update(productPhotos).set({ caption: parsed.data.caption === '' ? null : parsed.data.caption })
        .where(eq(productPhotos.id, photoId));
      await touch(tx, productId);
      await bumpConfigVersion(tx as unknown as Db, agentId);
    });
    return productById(agentId, productId);
  });

  app.delete(`${base}/:productId/photos/:photoId`, { preHandler: [guard, ownerOnly] }, async (req): Promise<Product> => {
    const { productId, photoId } = req.params as { productId: string; photoId: string };
    const agentId = req.agent!.id;

    const path = await db.transaction(async (tx) => {
      const photo = await ownPhoto(agentId, productId, photoId, tx);
      await tx.delete(productPhotos).where(eq(productPhotos.id, photoId));
      // Positions stay dense, so the next upload's `max + 1` lands right after the last photo.
      await tx.update(productPhotos).set({ position: sql`${productPhotos.position} - 1` })
        .where(and(eq(productPhotos.productId, productId), sql`${productPhotos.position} > ${photo.position}`));
      await touch(tx, productId);
      await bumpConfigVersion(tx as unknown as Db, agentId);
      return photo.mediaPath;
    });
    await removeStoredFiles(env.MEDIA_DIR, [path]);
    return productById(agentId, productId);
  });

  app.put(`${base}/:productId/photos/order`, { preHandler: [guard, ownerOnly] }, async (req): Promise<Product> => {
    const { productId } = req.params as { productId: string };
    const parsed = photoOrder.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, 'Не удалось разобрать порядок фото');
    const agentId = req.agent!.id;

    await db.transaction(async (tx) => {
      await ownProduct(agentId, productId, tx);
      const existing = await tx.select({ id: productPhotos.id }).from(productPhotos)
        .where(eq(productPhotos.productId, productId));
      const wanted = parsed.data.photoIds;
      // The whole set or nothing: a partial list would leave two photos sharing a position.
      const same = wanted.length === existing.length && new Set(wanted).size === wanted.length
        && existing.every((photo) => wanted.includes(photo.id));
      if (!same) throw new ApiError(409, 'Фото товара изменились. Обновите страницу и попробуйте снова.');
      for (const [position, id] of wanted.entries()) {
        await tx.update(productPhotos).set({ position }).where(eq(productPhotos.id, id));
      }
      await touch(tx, productId);
      await bumpConfigVersion(tx as unknown as Db, agentId);
    });
    return productById(agentId, productId);
  });

  app.get(`${base}/:productId/photos/:photoId/file`, { preHandler: [guard, anyMember] }, async (req, reply) => {
    const { productId, photoId } = req.params as { productId: string; photoId: string };
    const photo = await ownPhoto(req.agent!.id, productId, photoId);
    // The stored path only, never one from the request — the same rule the message media route keeps.
    const bytes = await readFile(join(env.MEDIA_DIR, photo.mediaPath)).catch(() => null);
    if (!bytes) throw new ApiError(404, 'Фото не найдено');
    return reply.type(photo.mediaMime).header('Cache-Control', 'private, max-age=3600').send(bytes);
  });
}
