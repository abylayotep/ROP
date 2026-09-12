import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_URL, runMigration, tagsBefore, withDatabase } from './helpers/migration-db.js';

const TARGET_TAG = '0029_knowledge_generation_raw_findings';

describe('migration 0029: legacy raw proposals become immutable findings', () => {
  const dbName = `rakurs_migrate_${randomUUID().replace(/-/g, '')}`;
  let adminSql: postgres.Sql;
  let scratchSql: postgres.Sql;
  const rawId = randomUUID();
  const proposalId = randomUUID();
  const createdAt = new Date('2026-09-12T03:04:05.000Z');
  let runId: string;
  let batchId: string;

  beforeAll(async () => {
    adminSql = postgres(ADMIN_URL, { max: 1 });
    await adminSql.unsafe(`CREATE DATABASE "${dbName}"`);
    scratchSql = postgres(withDatabase(ADMIN_URL, dbName), { max: 1 });
    for (const tag of tagsBefore(TARGET_TAG)) await runMigration(scratchSql, tag);

    const [account] = await scratchSql`INSERT INTO accounts (name) VALUES ('Migration') RETURNING id`;
    const [user] = await scratchSql`
      INSERT INTO users (email, password_hash, name, initials)
      VALUES ('raw-migration@example.test', 'x', 'Owner', 'OW') RETURNING id
    `;
    const [agent] = await scratchSql`
      INSERT INTO agents (account_id, name) VALUES (${account!.id}, 'Agent') RETURNING id
    `;
    const [run] = await scratchSql`
      INSERT INTO kb_generation_runs (
        agent_id, user_id, requested_preview_id, request_key, selection, manifest, counts,
        model_id, temperature, status
      ) VALUES (
        ${agent!.id}, ${user!.id}, ${randomUUID()}, 'migration', '{}', '{}', '{}',
        'model', '0.30', 'completed'
      ) RETURNING id
    `;
    runId = run!.id as string;
    const [batch] = await scratchSql`
      INSERT INTO kb_generation_batches (run_id, ordinal, manifest, status)
      VALUES (${run!.id}, 0, '{}', 'done') RETURNING id
    `;
    batchId = batch!.id as string;
    await scratchSql`
      INSERT INTO kb_generation_proposals (
        id, run_id, batch_id, fingerprint, path, body, warnings, sources, status, created_at
      ) VALUES (
        ${rawId}, ${run!.id}, ${batch!.id}, 'raw:batch:0:hash', 'База знаний/Доставка',
        'Доставка занимает два дня.', ARRAY['context_limited']::text[],
        ${scratchSql.json([{ conversationId: 'conversation-1', messageId: 'message-1', sentAt: createdAt.toISOString() }])},
        'rejected', ${createdAt}
      ), (
        ${proposalId}, ${run!.id}, ${batch!.id}, 'normal-hash', 'База знаний/Оплата',
        'Оплата при получении.', ARRAY[]::text[], ${scratchSql.json([])}, 'pending', ${createdAt}
      )
    `;

    await runMigration(scratchSql, TARGET_TAG);
  });

  afterAll(async () => {
    await scratchSql?.end();
    await adminSql.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await adminSql.end();
  });

  it('moves legacy raw rows with their audit fields and leaves normal proposals untouched', async () => {
    const proposals = await scratchSql`SELECT * FROM kb_generation_proposals ORDER BY id`;
    const findings = await scratchSql`SELECT * FROM kb_generation_raw_findings ORDER BY id`;

    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ id: proposalId, fingerprint: 'normal-hash', status: 'pending' });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      id: rawId,
      run_id: runId,
      batch_id: batchId,
      fingerprint: 'raw:batch:0:hash',
      path: 'База знаний/Доставка',
      body: 'Доставка занимает два дня.',
      warnings: ['context_limited'],
      sources: [{ conversationId: 'conversation-1', messageId: 'message-1', sentAt: createdAt.toISOString() }],
      created_at: createdAt,
    });
  });
});
