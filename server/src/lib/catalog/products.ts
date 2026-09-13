import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Product } from '@rakurs/contract';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { productPhotos, products, productVariants } from '../../db/schema.js';
import { storeInboundMedia } from '../whatsapp/media.js';

/**
 * The catalog: products, their prices and their photos.
 *
 * Read by two callers that need different slices of the same rows — the cabinet wants every
 * product with every detail, a turn wants the active ones in prompt order — so both go
 * through `loadProducts` and neither re-invents the three-table join.
 */

/** WhatsApp's own ceiling for an image; a bigger photo would upload here and fail at the send. */
export const PHOTO_MAX_BYTES = 5 * 1024 * 1024;
/** Enough angles to show a product; past that the agent is choosing between near-duplicates. */
export const PHOTOS_PER_PRODUCT = 10;
/** A size table, not a price list: more rows than this is a second product. */
export const VARIANTS_PER_PRODUCT = 20;

/**
 * The image type the bytes actually are, or null.
 *
 * Read from the first bytes rather than trusted from the upload's header: the browser's
 * `Content-Type` is whatever the file's extension suggested, and a `.jpg` that is really a
 * HEIC photo from an iPhone would be accepted here and rejected by WhatsApp at the send.
 */
export function sniffImage(bytes: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

/** Every product of the agent, in the owner's order, with variants and photos in theirs. */
export async function loadProducts(
  db: Db,
  agentId: string,
  options: { activeOnly?: boolean; productIds?: string[] } = {},
): Promise<Product[]> {
  const conditions = [eq(products.agentId, agentId)];
  if (options.activeOnly) conditions.push(eq(products.active, true));
  if (options.productIds) {
    if (options.productIds.length === 0) return [];
    conditions.push(inArray(products.id, options.productIds));
  }
  const rows = await db.select().from(products).where(and(...conditions))
    .orderBy(asc(products.position), asc(products.createdAt));
  if (rows.length === 0) return [];

  const ids = rows.map((row) => row.id);
  const variants = await db.select().from(productVariants).where(inArray(productVariants.productId, ids))
    .orderBy(asc(productVariants.position));
  const photos = await db.select().from(productPhotos).where(inArray(productPhotos.productId, ids))
    .orderBy(asc(productPhotos.position), asc(productPhotos.createdAt));

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    position: row.position,
    active: row.active,
    variants: variants.filter((variant) => variant.productId === row.id)
      .map(({ id, label, price, position }) => ({ id, label, price, position })),
    photos: photos.filter((photo) => photo.productId === row.id).map((photo) => ({
      id: photo.id,
      mime: photo.mediaMime,
      sizeBytes: photo.sizeBytes,
      filename: photo.filename,
      caption: photo.caption,
      position: photo.position,
      createdAt: photo.createdAt.toISOString(),
    })),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}

/**
 * Writes a photo's bytes where message files go, and answers the relative path.
 *
 * The same writer the inbound media and the operator's uploads use, so one directory layout,
 * one per-agent folder and one way of reading a file back serve all three. The `product.`
 * prefix keeps a photo's name from ever colliding with a WhatsApp message id.
 */
export async function storeProductPhoto(
  mediaDir: string,
  input: { agentId: string; photoId: string; bytes: Buffer; mime: string },
): Promise<string> {
  const stored = await storeInboundMedia(
    { mediaDir },
    { bytes: input.bytes, mime: input.mime, agentId: input.agentId, waMessageId: `product.${input.photoId}` },
  );
  return stored.path;
}

/**
 * Removes files whose rows are already gone. Best-effort: a file left on disk is wasted
 * space, while failing a delete the database already committed would show the owner an
 * error for something that did happen. A sent message never points here — it has its copy.
 */
export async function removeStoredFiles(mediaDir: string, paths: readonly string[]): Promise<void> {
  await Promise.all(paths.map((path) => unlink(join(mediaDir, path)).catch(() => undefined)));
}
