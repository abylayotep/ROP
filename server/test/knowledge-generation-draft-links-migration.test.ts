import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_URL, runMigration, tagsBefore, withDatabase } from './helpers/migration-db.js';

const TARGET_TAG = '0030_backfill_generation_draft_links';

describe('migration 0030: generation draft links', () => {
  const dbName = `rakurs_draft_links_${randomUUID().replace(/-/g, '')}`;
  let adminSql: postgres.Sql;
  let scratchSql: postgres.Sql;
  const runId = randomUUID();
  const draftId = randomUUID();

  beforeAll(async () => {
    adminSql = postgres(ADMIN_URL, { max: 1 });
    await adminSql.unsafe(`CREATE DATABASE "${dbName}"`);
    scratchSql = postgres(withDatabase(ADMIN_URL, dbName), { max: 1 });
    for (const tag of tagsBefore(TARGET_TAG)) await runMigration(scratchSql, tag);

    const [account] = await scratchSql`INSERT INTO accounts (name) VALUES ('Draft links') RETURNING id`;
    const [user] = await scratchSql`
      INSERT INTO users (email, password_hash, name, initials)
      VALUES ('draft-links@example.test', 'x', 'Owner', 'OW') RETURNING id
    `;
    const [agent] = await scratchSql`
      INSERT INTO agents (account_id, name) VALUES (${account!.id}, 'Agent') RETURNING id
    `;
    await scratchSql`
      INSERT INTO kb_drafts (id, agent_id, title, origin, status, ops, base, created_by)
      VALUES (${draftId}, ${agent!.id}, 'Legacy draft', 'manual', 'discarded', '[]', '{}', ${user!.id})
    `;
    await scratchSql`
      INSERT INTO kb_generation_runs (
        id, agent_id, user_id, requested_preview_id, request_key, selection, manifest, counts,
        model_id, temperature, status
      ) VALUES (
        ${runId}, ${agent!.id}, ${user!.id}, ${randomUUID()}, 'legacy-link', '{}', '{}', '{}',
        'model', '0.30', 'completed'
      )
    `;
    const [batch] = await scratchSql`
      INSERT INTO kb_generation_batches (run_id, ordinal, manifest, status)
      VALUES (${runId}, 0, '{}', 'done') RETURNING id
    `;
    await scratchSql`
      INSERT INTO kb_generation_proposals (
        run_id, batch_id, fingerprint, path, body, sources, status, draft_id, draft_op_index
      ) VALUES (
        ${runId}, ${batch!.id}, 'legacy-normal-link', 'База знаний/Legacy', 'Legacy body', '[]',
        'drafted', ${draftId}, 0
      )
    `;
  });

  afterAll(async () => {
    await scratchSql?.end();
    await adminSql.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await adminSql.end();
  });

  it('backfills every available proposal link and is safe to retry', async () => {
    await runMigration(scratchSql, TARGET_TAG);
    await runMigration(scratchSql, TARGET_TAG);

    expect(await scratchSql`
      SELECT run_id, draft_id FROM kb_generation_drafts
      WHERE run_id = ${runId} AND draft_id = ${draftId}
    `).toEqual([expect.objectContaining({ run_id: runId, draft_id: draftId })]);
  });
});
