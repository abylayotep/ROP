import { describe, expect, it } from 'vitest';
import { settings } from '../src/db/schema.js';
import { getSettings, toApiSettings, updateSettings } from '../src/lib/settings.js';
import { withDb } from './helpers/db.js';

describe('settings store', () => {
  it('creates the single row on first read', async () => {
    const db = await withDb();

    const row = await getSettings(db);

    expect(row.id).toBe(true);
    expect(await db.select().from(settings)).toHaveLength(1);
  });

  it('does not create a second row on later reads', async () => {
    const db = await withDb();
    await getSettings(db);
    await getSettings(db);

    expect(await db.select().from(settings)).toHaveLength(1);
  });

  it('stores selected accounts', async () => {
    const db = await withDb();

    const row = await updateSettings(db, { selectedAccounts: ['act_1', 'act_2'] });

    expect(row.selectedAccountIds).toEqual(['act_1', 'act_2']);
  });

  it('leaves untouched fields alone on a partial patch', async () => {
    const db = await withDb();
    await updateSettings(db, { syncMode: 'Вручную' });

    const row = await updateSettings(db, { selectedAccounts: ['act_9'] });

    expect(toApiSettings(row)).toEqual({ selectedAccounts: ['act_9'], syncMode: 'Вручную' });
  });

  it('patches an empty database without a prior read', async () => {
    const db = await withDb();

    expect((await updateSettings(db, { syncMode: 'Вручную' })).syncMode).toBe('Вручную');
  });
});
