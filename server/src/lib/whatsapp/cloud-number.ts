import type { whatsappNumbers } from '../../db/schema.js';

export type WhatsappNumberRow = typeof whatsappNumbers.$inferSelect;

/**
 * A number connected through Meta: `manual` or `coexistence`.
 *
 * The three columns below are nullable on the table because a linked device has none of
 * them, and null for those three is exactly what `connection_kind = 'linked'` means. The
 * database says so too — `whatsapp_numbers_cloud_columns_check` refuses a Cloud API row
 * missing any of them — so narrowing by kind is not a guess, it is reading the constraint.
 */
export type CloudNumberRow = WhatsappNumberRow & {
  phoneNumberId: string;
  wabaId: string;
  accessToken: string;
};

export const isCloudNumber = (row: WhatsappNumberRow): row is CloudNumberRow =>
  row.connectionKind !== 'linked';

/**
 * The same row, typed as what it is, for code that only ever runs for a Cloud API number.
 *
 * Throws rather than returning null: every caller today is on a path that cannot be reached
 * by a linked number, and a silent null would turn a routing bug into a message that is
 * quietly never sent. The message names the row so the bug is findable.
 */
export function asCloudNumber(row: WhatsappNumberRow): CloudNumberRow {
  if (!isCloudNumber(row)) {
    throw new Error(`whatsapp number ${row.id} is ${row.connectionKind}, not a Cloud API number`);
  }
  return row;
}
