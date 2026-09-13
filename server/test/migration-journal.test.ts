import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DRIZZLE_DIR } from './helpers/migration-db.js';

type JournalEntry = { idx: number; when: number; tag: string };

const journal = JSON.parse(readFileSync(path.join(DRIZZLE_DIR, 'meta/_journal.json'), 'utf8')) as {
  entries: JournalEntry[];
};

/**
 * The tail of the history production has already applied, exactly as it recorded it.
 *
 * Drizzle's migrator skips every migration whose `when` is not newer than the newest row in
 * `drizzle.__drizzle_migrations`. Renumbering, retiming or replacing one of these entries does
 * not re-run it anywhere; it silently skips whatever lands before production's newest `when`.
 * That is how two branches once diverged at 0029 with different files under the same numbers.
 * New migrations are appended after the last entry; these never change.
 */
const APPLIED_IN_PRODUCTION: Array<[number, number, string]> = [
  [28, 1789204102088, '0028_sparkling_vampiro'],
  [29, 1789204102089, '0029_knowledge_review_workspace'],
  [30, 1789204102090, '0030_knowledge_generation_raw_findings'],
  [31, 1789204102091, '0031_backfill_generation_draft_links'],
  [32, 1789204102092, '0032_migrate_remaining_legacy_raw_proposals'],
  [33, 1789220646644, '0033_generation_draft_request_key'],
  [34, 1789225134093, '0034_material_nico_minoru'],
  [35, 1789286400000, '0035_crm_analysis_mode'],
];

describe('migration journal', () => {
  it('keeps the history production applied unchanged', () => {
    for (const [idx, when, tag] of APPLIED_IN_PRODUCTION) {
      expect(journal.entries[idx]).toMatchObject({ idx, when, tag });
    }
  });

  it('orders entries by a strictly increasing index and timestamp', () => {
    journal.entries.forEach((entry, position) => {
      expect(entry.idx).toBe(position);
      if (position > 0) expect(entry.when).toBeGreaterThan(journal.entries[position - 1]!.when);
    });
  });

  it('has exactly one SQL file per entry', () => {
    const numbers = journal.entries.map((entry) => entry.tag.slice(0, 4));
    expect(new Set(numbers).size).toBe(numbers.length);
    for (const entry of journal.entries) {
      expect(existsSync(path.join(DRIZZLE_DIR, `${entry.tag}.sql`))).toBe(true);
    }
  });
});
