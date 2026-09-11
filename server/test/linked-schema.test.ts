import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { agents, whatsappNumbers } from '../src/db/schema.js';
import { createAccountWithOwner } from '../src/lib/provision.js';
import { withDb } from './helpers/db.js';

/**
 * The columns a linked device does not have, and the ones it must.
 *
 * A Cloud API number is identified by `phone_number_id` and speaks through a token; a linked
 * device has neither and is identified by its own jid. Both shapes live in one table because
 * `conversations.whatsapp_number_id` points at it, so the constraints below are what keeps a
 * half-filled row of either kind out — the failure it would otherwise cause is a refused send
 * hours later, with nothing at the insert to say why.
 */

let db: Awaited<ReturnType<typeof withDb>>;
let agentId: string;

beforeEach(async () => {
  db = await withDb();
  const { accountId } = await createAccountWithOwner(db, {
    company: 'Sealhouse',
    email: 'owner@example.com',
    name: 'Владелец',
    initials: 'ВЛ',
    password: 'correct-horse-battery',
  });
  const [agent] = await db.insert(agents).values({ accountId, name: 'Sealhouse' }).returning();
  agentId = agent!.id;
});

describe('linked numbers schema', () => {
  it('accepts a linked number with none of the Cloud API columns', async () => {
    const [row] = await db
      .insert(whatsappNumbers)
      .values({
        agentId,
        displayPhone: '+7 700 000 00 00',
        connectionKind: 'linked',
        linkedJid: '77000000000@s.whatsapp.net',
        linkedState: 'open',
      })
      .returning();

    expect(row).toMatchObject({
      connectionKind: 'linked',
      phoneNumberId: null,
      wabaId: null,
      accessToken: null,
      linkedState: 'open',
    });
  });

  it('refuses a linked number with no jid', async () => {
    await expect(
      db.insert(whatsappNumbers).values({
        agentId,
        displayPhone: '+7 700 000 00 00',
        connectionKind: 'linked',
        linkedState: 'open',
      }),
    ).rejects.toThrow();
  });

  it('refuses a linked number with no state', async () => {
    await expect(
      db.insert(whatsappNumbers).values({
        agentId,
        displayPhone: '+7 700 000 00 00',
        connectionKind: 'linked',
        linkedJid: '77000000000@s.whatsapp.net',
      }),
    ).rejects.toThrow();
  });

  it('refuses a manual number with no access token', async () => {
    await expect(
      db.insert(whatsappNumbers).values({
        agentId,
        displayPhone: '+7 700 000 00 00',
        connectionKind: 'manual',
        phoneNumberId: '100',
        wabaId: '200',
      }),
    ).rejects.toThrow();
  });

  it('refuses a coexistence number with no phone number id', async () => {
    await expect(
      db.insert(whatsappNumbers).values({
        agentId,
        displayPhone: '+7 700 000 00 00',
        connectionKind: 'coexistence',
        wabaId: '200',
        accessToken: 'encrypted',
      }),
    ).rejects.toThrow();
  });

  it('lets two linked numbers coexist, both with a null phone_number_id', async () => {
    // The uniqueness on `phone_number_id` is what makes webhook routing unambiguous, and it
    // has nothing to say about numbers that have no such id. A plain unique index would
    // already allow this — Postgres treats nulls as distinct — but the partial index is what
    // states the intent, so nobody later "fixes" it into a total one.
    for (const jid of ['77000000001@s.whatsapp.net', '77000000002@s.whatsapp.net']) {
      await db.insert(whatsappNumbers).values({
        agentId,
        displayPhone: jid,
        connectionKind: 'linked',
        linkedJid: jid,
        linkedState: 'open',
      });
    }

    expect(await db.select().from(whatsappNumbers)).toHaveLength(2);
  });

  it('still refuses the same phone_number_id twice', async () => {
    const values = {
      agentId,
      displayPhone: '+7 708 580 79 32',
      connectionKind: 'manual' as const,
      phoneNumberId: '1367497639773085',
      wabaId: '932647766535299',
      accessToken: 'encrypted',
    };
    await db.insert(whatsappNumbers).values(values);

    await expect(db.insert(whatsappNumbers).values(values)).rejects.toThrow();
  });

  it('keeps a session key per number, category and id', async () => {
    const [number] = await db
      .insert(whatsappNumbers)
      .values({
        agentId,
        displayPhone: '+7 700 000 00 00',
        connectionKind: 'linked',
        linkedJid: '77000000000@s.whatsapp.net',
        linkedState: 'open',
      })
      .returning();

    await db.execute(
      sql`insert into linked_session_keys (whatsapp_number_id, category, key_id, value)
          values (${number!.id}, 'creds', 'me', 'encrypted')`,
    );

    await expect(
      db.execute(
        sql`insert into linked_session_keys (whatsapp_number_id, category, key_id, value)
            values (${number!.id}, 'creds', 'me', 'other')`,
      ),
    ).rejects.toThrow();
  });

  it('drops the session keys with the number they belong to', async () => {
    const [number] = await db
      .insert(whatsappNumbers)
      .values({
        agentId,
        displayPhone: '+7 700 000 00 00',
        connectionKind: 'linked',
        linkedJid: '77000000000@s.whatsapp.net',
        linkedState: 'open',
      })
      .returning();
    await db.execute(
      sql`insert into linked_session_keys (whatsapp_number_id, category, key_id, value)
          values (${number!.id}, 'creds', 'me', 'encrypted')`,
    );

    await db.delete(whatsappNumbers);

    const rows = await db.execute(sql`select count(*)::int as count from linked_session_keys`);
    expect((rows as unknown as { count: number }[])[0]!.count).toBe(0);
  });
});
