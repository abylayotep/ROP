import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_URL, runMigration, tagsBefore, withDatabase } from './helpers/migration-db.js';

/**
 * Proves migration 0050 (every `awaiting_payment` stage merged into its agent's sale stage)
 * on a disposable database: it runs once against real funnels, so the move itself is what
 * is worth testing, including an agent that has no sale stage to merge into.
 */

const TARGET_TAG = '0050_merge_awaiting_payment';

describe('migration 0050: awaiting_payment stages merge into the sale stage', () => {
  const dbName = `rakurs_migrate_${randomUUID().replace(/-/g, '')}`;
  let adminSql: postgres.Sql;
  let sql: postgres.Sql;

  let agentA: string;
  let newLeadIdA: string;
  let saleIdA: string;
  let movedIds: string[];
  let untouchedId: string;
  let analyzedId: string;
  let stageBId: string;
  let conversationBId: string;

  async function stage(agentId: string, name: string, kind: string, position: number): Promise<string> {
    const [row] = await sql`INSERT INTO stages (agent_id, name, color, kind, position)
      VALUES (${agentId}, ${name}, '#8a94a6', ${kind}, ${position}) RETURNING id`;
    return row!.id as string;
  }

  async function conversation(agentId: string, numberId: string, phone: string, stageId: string): Promise<string> {
    const [contact] = await sql`INSERT INTO contacts (agent_id, phone) VALUES (${agentId}, ${phone}) RETURNING id`;
    const [row] = await sql`INSERT INTO conversations (agent_id, contact_id, whatsapp_number_id, stage_id, stage_set_at, stage_set_by)
      VALUES (${agentId}, ${contact!.id}, ${numberId}, ${stageId}, now() - interval '1 day', 'ai') RETURNING id`;
    return row!.id as string;
  }

  async function number(agentId: string, phoneNumberId: string): Promise<string> {
    const [row] = await sql`INSERT INTO whatsapp_numbers (agent_id, phone_number_id, waba_id, display_phone, access_token)
      VALUES (${agentId}, ${phoneNumberId}, 'waba', '+7 700 000 00 00', 'x') RETURNING id`;
    return row!.id as string;
  }

  beforeAll(async () => {
    adminSql = postgres(ADMIN_URL, { max: 1 });
    await adminSql.unsafe(`CREATE DATABASE "${dbName}"`);
    sql = postgres(withDatabase(ADMIN_URL, dbName), { max: 1, onnotice: () => {} });

    for (const tag of tagsBefore(TARGET_TAG)) {
      await runMigration(sql, tag);
    }

    const [account] = await sql`INSERT INTO accounts (name) VALUES ('Сафина') RETURNING id`;
    const [a] = await sql`INSERT INTO agents (account_id, name) VALUES (${account!.id}, 'Агент А') RETURNING id`;
    const [b] = await sql`INSERT INTO agents (account_id, name) VALUES (${account!.id}, 'Агент Б') RETURNING id`;
    agentA = a!.id as string;
    const agentB = b!.id as string;

    newLeadIdA = await stage(agentA, 'Новый лид', 'active', 0);
    await stage(agentA, 'Готов к покупке', 'active', 1);
    const orderedA = await stage(agentA, 'Заказано', 'awaiting_payment', 2);
    saleIdA = await stage(agentA, 'Оплачено', 'success', 3);
    await stage(agentA, 'Отказ', 'failure', 4);

    const numberA = await number(agentA, 'a-136');
    movedIds = [
      await conversation(agentA, numberA, '77000000001', orderedA),
      await conversation(agentA, numberA, '77000000002', orderedA),
    ];
    untouchedId = await conversation(agentA, numberA, '77000000003', newLeadIdA);

    analyzedId = movedIds[0]!;
    const [message] = await sql`INSERT INTO messages (conversation_id, direction, author, kind, body, sent_at)
      VALUES (${analyzedId}, 'in', 'client', 'text', 'Оплатил', now()) RETURNING id`;
    await sql`INSERT INTO crm_analyses (conversation_id, analyzed_message_id, status, lease_token, lease_until)
      VALUES (${analyzedId}, ${message!.id}, 'ready', ${randomUUID()}, now() + interval '1 minute')`;

    stageBId = await stage(agentB, 'Ждёт', 'awaiting_payment', 0);
    await stage(agentB, 'Новый', 'active', 1);
    conversationBId = await conversation(agentB, await number(agentB, 'b-136'), '77000000004', stageBId);

    await runMigration(sql, TARGET_TAG);
  });

  afterAll(async () => {
    await sql?.end();
    await adminSql.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await adminSql.end();
  });

  it('merges the ordered stage into the sale stage and keeps its history', async () => {
    const stagesA = await sql`SELECT name, position FROM stages WHERE agent_id = ${agentA} ORDER BY position`;
    const stageNamesA = stagesA.map((row) => row.name);
    const positionsA = stagesA.map((row) => row.position);
    const movedConversations = await sql`SELECT stage_id, stage_set_by FROM conversations WHERE id IN ${sql(movedIds)}`;
    const [untouched] = await sql`SELECT stage_id FROM conversations WHERE id = ${untouchedId}`;
    const transitionsA = await sql`SELECT * FROM stage_transitions WHERE agent_id = ${agentA}`;
    const [analysis] = await sql`SELECT * FROM crm_analyses WHERE conversation_id = ${analyzedId}`;
    const [stageB] = await sql`SELECT id, name, kind FROM stages WHERE id = ${stageBId}`;
    const [conversationB] = await sql`SELECT stage_id FROM conversations WHERE id = ${conversationBId}`;

    // agent A
    expect(stageNamesA).toEqual(['Новый лид', 'Готов к покупке', 'Оплачено', 'Отказ']);
    expect(positionsA).toEqual([0, 1, 2, 3]);
    expect(movedConversations).toHaveLength(2);
    expect(movedConversations.every((c) => c.stage_id === saleIdA && c.stage_set_by === 'system')).toBe(true);
    expect(untouched!.stage_id).toBe(newLeadIdA);
    expect(transitionsA).toHaveLength(2);
    expect(transitionsA[0]).toMatchObject({ from_name: 'Заказано', to_name: 'Оплачено', to_kind: 'success', moved_by: 'system' });
    expect(analysis).toMatchObject({ analyzed_message_id: null, status: 'pending', lease_token: null });
    // agent B keeps its lead and the stage becomes active
    expect(stageB).toMatchObject({ name: 'Ждёт', kind: 'active' });
    expect(conversationB!.stage_id).toBe(stageB!.id);
    expect(await sql`select 1 from stages where kind = 'awaiting_payment'`).toHaveLength(0);
  });
});
