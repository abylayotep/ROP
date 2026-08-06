import type { Settings } from '@rakurs/contract';
import type { Db } from '../db/client.js';
import { settings } from '../db/schema.js';

export type SettingsRow = typeof settings.$inferSelect;

const DEFAULTS = {
  projectName: 'Ракурс',
  planLine: '',
  currency: 'KZT',
  usdRate: '450',
  timezone: 'Asia/Almaty',
  syncMode: 'Автоматически',
  selectedAccountIds: [] as string[],
};

/**
 * Reads the single settings row, creating it on first boot.
 *
 * The conflict clause matters: api and worker start together, and both can reach this
 * on an empty database at the same moment.
 */
export async function getSettings(db: Db): Promise<SettingsRow> {
  const [existing] = await db.select().from(settings);
  if (existing) return existing;

  const [created] = await db.insert(settings).values(DEFAULTS).onConflictDoNothing().returning();
  if (created) return created;

  const [raced] = await db.select().from(settings);
  return raced!;
}

export async function updateSettings(db: Db, patch: Partial<Settings>): Promise<SettingsRow> {
  await getSettings(db); // the row must exist before the update matches anything

  const [row] = await db
    .update(settings)
    .set({
      ...(patch.selectedAccounts ? { selectedAccountIds: patch.selectedAccounts } : null),
      ...(patch.syncMode ? { syncMode: patch.syncMode } : null),
      updatedAt: new Date(),
    })
    .returning();
  return row!;
}

export const toApiSettings = (row: SettingsRow): Settings => ({
  selectedAccounts: row.selectedAccountIds,
  syncMode: row.syncMode,
});
