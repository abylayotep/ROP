# Task 7a: The settings store

Part of [Foundation Implementation Plan](2026-08-06-foundation.md). Global constraints there apply.
Routes are [task 7b](2026-08-06-foundation-task-7b-profile-routes.md).

**Files:**
- Create: `server/src/lib/settings.ts`, `server/test/settings-store.test.ts`
- Modify: `packages/contract/index.ts`, `rakurs/src/api/index.ts:37-41`

**Interfaces:**
- Consumes: `Db` and the `settings` table (task 3).
- Produces: `Settings` exported from `@rakurs/contract`; `SettingsRow`;
  `getSettings(db: Db): Promise<SettingsRow>`;
  `updateSettings(db: Db, patch: Partial<Settings>): Promise<SettingsRow>`;
  `toApiSettings(row: SettingsRow): Settings`.

- [ ] **Step 1: Move `Settings` into the contract**

It is a wire type that currently lives in the frontend's `api/index.ts`. Append to
`packages/contract/index.ts`:

```ts
// ── Settings ───────────────────────────────────────────────────────────────

export interface Settings {
  /** Selected ad accounts — campaigns and creatives come from these. */
  selectedAccounts: string[];
  syncMode: string;
}
```

- [ ] **Step 2: Re-export it from the frontend**

In `rakurs/src/api/index.ts`, replace the local `export interface Settings { … }` block with a
re-export. Every call site stays untouched:

```ts
export type { Settings } from '@rakurs/contract';
```

- [ ] **Step 3: Write the failing test**

`server/test/settings-store.test.ts`:

```ts
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
```

- [ ] **Step 4: Run it and watch it fail**

Run: `npm --prefix server test settings-store`
Expected: FAIL — `../src/lib/settings.js` does not exist.

- [ ] **Step 5: Implement**

`server/src/lib/settings.ts`:

```ts
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
  await getSettings(db);   // the row must exist before the update matches anything

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
```

- [ ] **Step 6: Run the tests**

```bash
docker compose -f deploy/compose.test.yml up -d
npm --prefix server test settings-store
```

Expected: PASS, 5 tests.

- [ ] **Step 7: Typecheck both packages**

```bash
npm --prefix server run typecheck && npm --prefix rakurs run typecheck
```

Expected: both pass. The frontend check confirms the `Settings` re-export broke no call site.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "Add the settings store and move Settings into the contract"
```
