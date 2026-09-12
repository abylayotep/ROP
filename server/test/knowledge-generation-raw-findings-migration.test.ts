import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { FastifyInstance } from 'fastify';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import * as schema from '../src/db/schema.js';
import { hashPassword } from '../src/lib/password.js';
import { testEnv } from './helpers/env.js';
import { fakeGraph } from './helpers/fake-graph.js';
import { fakeModel } from './helpers/fake-model.js';
import { ADMIN_URL, runMigration, tagsBefore, withDatabase } from './helpers/migration-db.js';

const TARGET_TAG = '0029_knowledge_generation_raw_findings';
const PASSWORD = 'correct-horse-battery';

describe('migration 0029: legacy raw proposals become immutable findings', () => {
  const dbName = `rakurs_migrate_${randomUUID().replace(/-/g, '')}`;
  let adminSql: postgres.Sql;
  let scratchSql: postgres.Sql;
  let app: FastifyInstance;
  const rawId = randomUUID();
  const appliedRawId = randomUUID();
  const discardedRawId = randomUUID();
  const proposalId = randomUUID();
  const openDraftId = randomUUID();
  const appliedDraftId = randomUUID();
  const discardedDraftId = randomUUID();
  const createdAt = new Date('2026-09-12T03:04:05.000Z');
  let runId: string;
  let batchId: string;
  let agentId: string;
  let cookieJar: Record<string, string>;

  beforeAll(async () => {
    adminSql = postgres(ADMIN_URL, { max: 1 });
    await adminSql.unsafe(`CREATE DATABASE "${dbName}"`);
    scratchSql = postgres(withDatabase(ADMIN_URL, dbName), { max: 1 });
    for (const tag of tagsBefore(TARGET_TAG)) await runMigration(scratchSql, tag);

    const [account] = await scratchSql`INSERT INTO accounts (name) VALUES ('Migration') RETURNING id`;
    const [user] = await scratchSql`
      INSERT INTO users (email, password_hash, name, initials)
      VALUES ('raw-migration@example.test', ${await hashPassword(PASSWORD)}, 'Owner', 'OW') RETURNING id
    `;
    await scratchSql`
      INSERT INTO account_members (account_id, user_id, role)
      VALUES (${account!.id}, ${user!.id}, 'owner')
    `;
    const [agent] = await scratchSql`
      INSERT INTO agents (account_id, name) VALUES (${account!.id}, 'Agent') RETURNING id
    `;
    agentId = agent!.id as string;
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
      INSERT INTO kb_drafts (id, agent_id, title, origin, status, ops, base, created_by)
      VALUES
        (${openDraftId}, ${agent!.id}, 'Raw open', 'manual', 'open',
          ${scratchSql.json([{ op: 'note_create', path: 'Unsafe raw', body: 'Unreviewed raw text.' }])}, '{}', ${user!.id}),
        (${appliedDraftId}, ${agent!.id}, 'Raw applied', 'manual', 'applied', '[]', '{}', ${user!.id}),
        (${discardedDraftId}, ${agent!.id}, 'Raw discarded', 'manual', 'discarded', '[]', '{}', ${user!.id})
    `;
    await scratchSql`
      INSERT INTO kb_generation_proposals (
        id, run_id, batch_id, fingerprint, path, body, warnings, sources, status,
        draft_id, draft_op_index, created_at
      ) VALUES (
        ${rawId}, ${run!.id}, ${batch!.id}, 'raw:batch:0:hash', 'База знаний/Доставка',
        'Доставка занимает два дня.', ARRAY['context_limited']::text[],
        ${scratchSql.json([{ conversationId: 'conversation-1', messageId: 'message-1', sentAt: createdAt.toISOString() }])},
        'drafted', ${openDraftId}, 0, ${createdAt}
      ), (
        ${appliedRawId}, ${run!.id}, ${batch!.id}, 'raw:batch:1:hash', 'База знаний/Опубликовано',
        'Уже опубликовано.', ARRAY[]::text[], ${scratchSql.json([])},
        'applied', ${appliedDraftId}, 0, ${createdAt}
      ), (
        ${discardedRawId}, ${run!.id}, ${batch!.id}, 'raw:batch:2:hash', 'База знаний/Отклонено',
        'Уже отклонено.', ARRAY[]::text[], ${scratchSql.json([])},
        'rejected', ${discardedDraftId}, 0, ${createdAt}
      ), (
        ${proposalId}, ${run!.id}, ${batch!.id}, 'normal-hash', 'База знаний/Оплата',
        'Оплата при получении.', ARRAY[]::text[], ${scratchSql.json([])},
        'pending', NULL, NULL, ${createdAt}
      )
    `;

    await runMigration(scratchSql, TARGET_TAG);

    const db = drizzle(scratchSql, { schema });
    app = buildServer(testEnv({ DATABASE_URL: withDatabase(ADMIN_URL, dbName) }), db, {
      graph: fakeGraph(),
      model: fakeModel('{}'),
    });
    await app.ready();
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'raw-migration@example.test', password: PASSWORD },
    });
    const cookie = login.cookies[0]!;
    cookieJar = { [cookie.name]: cookie.value };
  });

  afterAll(async () => {
    await app?.close();
    await scratchSql?.end();
    await adminSql.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await adminSql.end();
  });

  it('moves legacy raw rows with their audit fields and leaves normal proposals untouched', async () => {
    const proposals = await scratchSql`SELECT * FROM kb_generation_proposals ORDER BY id`;
    const findings = await scratchSql`SELECT * FROM kb_generation_raw_findings ORDER BY id`;

    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ id: proposalId, fingerprint: 'normal-hash', status: 'pending' });
    expect(findings).toHaveLength(3);
    const migrated = findings.find((row) => row.id === rawId);
    expect(migrated).toMatchObject({
      id: rawId,
      run_id: runId,
      batch_id: batchId,
      fingerprint: 'raw:batch:0:hash',
      path: 'База знаний/Доставка',
      body: 'Доставка занимает два дня.',
      warnings: ['context_limited'],
      sources: [{ conversationId: 'conversation-1', messageId: 'message-1', sentAt: createdAt.toISOString() }],
    });
    expect(new Date(migrated!.created_at as string | Date).toISOString()).toBe(createdAt.toISOString());
  });

  it('discards only linked open drafts and prevents their raw ops from being applied', async () => {
    const drafts = await scratchSql`
      SELECT id, status FROM kb_drafts
      WHERE id IN (${openDraftId}, ${appliedDraftId}, ${discardedDraftId})
      ORDER BY id
    `;
    expect(drafts).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: openDraftId, status: 'discarded' }),
      expect.objectContaining({ id: appliedDraftId, status: 'applied' }),
      expect.objectContaining({ id: discardedDraftId, status: 'discarded' }),
    ]));

    const response = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/drafts/${openDraftId}/apply`,
      cookies: cookieJar,
    });
    expect(response.statusCode).toBe(409);
    expect(await scratchSql`SELECT id FROM kb_notes WHERE path = 'Unsafe raw'`).toEqual([]);
  });
});
