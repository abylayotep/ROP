import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_URL, runMigration, tagsBefore, withDatabase } from './helpers/migration-db.js';

const TARGET_TAG = '0033_generation_draft_request_key';

describe('migration 0033: generation draft request identity', () => {
  const dbName = `rakurs_migrate_${randomUUID().replace(/-/g, '')}`;
  let adminSql: postgres.Sql;
  let scratchSql: postgres.Sql;
  let runId: string;
  let existingDraftId: string;

  beforeAll(async () => {
    adminSql = postgres(ADMIN_URL, { max: 1 });
    await adminSql.unsafe(`CREATE DATABASE "${dbName}"`);
    scratchSql = postgres(withDatabase(ADMIN_URL, dbName), { max: 1 });
    for (const tag of tagsBefore(TARGET_TAG)) await runMigration(scratchSql, tag);

    const [account] = await scratchSql`INSERT INTO accounts (name) VALUES ('Migration') RETURNING id`;
    const [user] = await scratchSql`
      INSERT INTO users (email, password_hash, name, initials)
      VALUES ('draft-key-migration@example.test', 'x', 'Owner', 'OW') RETURNING id
    `;
    const [agent] = await scratchSql`
      INSERT INTO agents (account_id, name) VALUES (${account!.id}, 'Agent') RETURNING id
    `;
    const [run] = await scratchSql`
      INSERT INTO kb_generation_runs (
        agent_id, user_id, requested_preview_id, request_key, selection, manifest, counts,
        model_id, temperature, status
      ) VALUES (
        ${agent!.id}, ${user!.id}, ${randomUUID()}, 'migration-run', '{}', '{}', '{}',
        'model', '0.30', 'completed'
      ) RETURNING id
    `;
    runId = run!.id as string;
    const [draft] = await scratchSql`
      INSERT INTO kb_drafts (agent_id, title, origin, ops, base, created_by)
      VALUES (${agent!.id}, 'Existing draft', 'manual', '[]', '{}', ${user!.id}) RETURNING id
    `;
    existingDraftId = draft!.id as string;
    await scratchSql`
      INSERT INTO kb_generation_drafts (run_id, draft_id) VALUES (${runId}, ${existingDraftId})
    `;

    await runMigration(scratchSql, TARGET_TAG);
  });

  afterAll(async () => {
    await scratchSql?.end();
    await adminSql.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await adminSql.end();
  });

  it('keeps historical links nullable and stores identity for new request groups', async () => {
    const [historical] = await scratchSql`
      SELECT request_key FROM kb_generation_drafts
      WHERE run_id = ${runId} AND draft_id = ${existingDraftId}
    `;
    expect(historical).toMatchObject({ request_key: null });

    const [draft] = await scratchSql`
      INSERT INTO kb_drafts (agent_id, title, origin, ops, base, created_by)
      SELECT agent_id, 'New draft', 'manual', '[]', '{}', created_by
      FROM kb_drafts WHERE id = ${existingDraftId}
      RETURNING id
    `;
    const requestKey = 'a'.repeat(64);
    await scratchSql`
      INSERT INTO kb_generation_drafts (run_id, draft_id, request_key)
      VALUES (${runId}, ${draft!.id}, ${requestKey})
    `;
    const [stored] = await scratchSql`
      SELECT request_key FROM kb_generation_drafts WHERE draft_id = ${draft!.id}
    `;
    expect(stored).toMatchObject({ request_key: requestKey });
  });
});
