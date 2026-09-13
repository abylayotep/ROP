import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { agents, contacts, conversations, linkedHistoryMappings, messages, whatsappNumbers } from '../src/db/schema.js';
import { createAccountWithOwner } from '../src/lib/provision.js';
import type { RawLinkedHistory, RawLinkedMessage } from '../src/lib/whatsapp/linked/client.js';
import { applyHistoryChunk, applyHistoryChunkWithReport } from '../src/lib/whatsapp/linked/history.js';
import { registerLinkedHistory } from '../src/lib/whatsapp/linked/history.js';
import { forgetLids } from '../src/lib/whatsapp/linked/lid-directory.js';
import { fakeLinked } from './helpers/fake-linked.js';
import { withDb } from './helpers/db.js';

/**
 * The chats the phone already had.
 *
 * Two properties carry the whole feature, and both are about restraint: an imported
 * message is never answered, and its file is never fetched. Everything else is the same
 * writing the live pipeline does.
 */

let db: Awaited<ReturnType<typeof withDb>>;
let agentId: string;
let numberId: string;

const JID = '77085807932@s.whatsapp.net';
const LID = '47536731594988@lid';

function raw(over: Partial<RawLinkedMessage> = {}): RawLinkedMessage {
  return {
    key: { id: 'old.1', remoteJid: JID, fromMe: false },
    messageTimestamp: 1_770_000_000,
    pushName: 'Айгерим',
    message: { conversation: 'Сколько стоит?' },
    ...over,
  };
}

const chunk = (over: Partial<RawLinkedHistory> = {}): RawLinkedHistory => ({
  messages: [raw()],
  contacts: [],
  ...over,
});

async function until(done: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!done() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
}

beforeEach(async () => {
  forgetLids();
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
  const [number] = await db
    .insert(whatsappNumbers)
    .values({
      agentId,
      displayPhone: '+7 708 580 79 32',
      connectionKind: 'linked',
      linkedJid: JID,
      linkedState: 'open',
    })
    .returning();
  numberId = number!.id;
});

describe('history import', () => {
  it('imports inbound ad metadata once without attributing the owner reply', async () => {
    const ad = (id: string, fromMe = false): RawLinkedMessage => raw({
      key: { id, remoteJid: JID, fromMe },
      message: { imageMessage: { caption: 'Ad response', contextInfo: {
        externalAdReply: { sourceId: id, sourceType: 'ad', title: 'History ad' },
      } } },
    });
    await applyHistoryChunk(db, numberId, chunk({ messages: [ad('owner', true)] }));
    expect((await db.select().from(conversations))[0]?.referralSeenAt).toBeNull();
    await applyHistoryChunk(db, numberId, chunk({ messages: [ad('first'), ad('second')] }));
    await applyHistoryChunk(db, numberId, chunk({ messages: [ad('first')] }));
    expect((await db.select().from(conversations))[0]).toMatchObject({
      adSourceId: 'first', adSourceType: 'ad', adHeadline: 'History ad',
      ctwaClid: null, referralSeenAt: expect.any(Date),
    });
  });

  it('persists the complete history mapping table and restores it after restart', async () => {
    await applyHistoryChunk(db, numberId, chunk({
      phoneNumberToLidMappings: [{ pnJid: JID, lidJid: LID }],
      messages: [],
    }));
    expect(await db.select().from(linkedHistoryMappings)).toMatchObject([
      { numberId, lid: '47536731594988', phone: '77085807932' },
    ]);

    forgetLids();
    await applyHistoryChunk(db, numberId, chunk({
      messages: [raw({ key: { id: 'after.restart', remoteJid: LID, fromMe: true } })],
    }));

    expect((await db.select().from(messages))[0]?.waMessageId).toBe('after.restart');
  });

  it('keeps persisted LID mappings isolated between linked numbers', async () => {
    const OTHER_JID = '77010000001@s.whatsapp.net';
    const [otherNumber] = await db.insert(whatsappNumbers).values({
      agentId,
      displayPhone: '+7 701 000 00 01',
      connectionKind: 'linked',
      linkedJid: OTHER_JID,
      linkedState: 'open',
    }).returning();
    await applyHistoryChunk(db, numberId, chunk({
      phoneNumberToLidMappings: [{ pnJid: JID, lidJid: LID }],
      messages: [],
    }));
    await applyHistoryChunk(db, otherNumber!.id, chunk({
      phoneNumberToLidMappings: [{ pnJid: OTHER_JID, lidJid: LID }],
      messages: [],
    }));

    forgetLids();
    await applyHistoryChunk(db, numberId, chunk({
      messages: [raw({ key: { id: 'tenant.one', remoteJid: LID, fromMe: true } })],
    }));
    await applyHistoryChunk(db, otherNumber!.id, chunk({
      messages: [raw({ key: { id: 'tenant.two', remoteJid: LID, fromMe: true } })],
    }));

    expect((await db.select().from(contacts)).map((row) => row.phone).sort()).toEqual([
      '77010000001',
      '77085807932',
    ]);
  });

  it('reports stored, duplicate, excluded and unresolved messages separately', async () => {
    const input = chunk({ messages: [
      raw({ key: { id: 'count.saved', remoteJid: JID, fromMe: false } }),
      raw({ key: { id: 'count.excluded', remoteJid: '120363@g.us', fromMe: false } }),
      raw({ key: { id: 'count.unresolved', remoteJid: LID, fromMe: true } }),
    ] });

    expect(await applyHistoryChunkWithReport(db, numberId, input)).toEqual({
      received: 3,
      saved: 1,
      duplicates: 0,
      excluded: 1,
      skippedUnresolved: 1,
    });
    expect(await applyHistoryChunkWithReport(db, numberId, input)).toEqual({
      received: 3,
      saved: 0,
      duplicates: 1,
      excluded: 1,
      skippedUnresolved: 1,
    });
  });

  it('uses chat phone mappings for both directions when individual history messages omit senderPn', async () => {
    await applyHistoryChunk(db, numberId, chunk({
      chats: [{ id: LID, pnJid: JID }],
      messages: [raw({ key: { id: 'mapped.in', remoteJid: LID, fromMe: false } }),
        raw({ key: { id: 'mapped.out', remoteJid: LID, fromMe: true } })],
    }));
    expect((await db.select().from(messages)).map(row => row.waMessageId).sort()).toEqual(['mapped.in', 'mapped.out']);
    expect((await db.select().from(contacts))[0]?.phone).toBe('77085807932');
  });

  it('learns the phone and LID pair supplied by history contacts', async () => {
    await applyHistoryChunk(db, numberId, chunk({ contacts: [{ id: JID, lid: LID }],
      messages: [raw({ key: { id: 'contact.mapping', remoteJid: LID, fromMe: false } })] }));
    expect((await db.select().from(messages))[0]?.waMessageId).toBe('contact.mapping');
  });
  it('writes the contact, the thread and the message', async () => {
    await applyHistoryChunk(db, numberId, chunk());

    expect(await db.select().from(contacts)).toHaveLength(1);
    expect(await db.select().from(conversations)).toHaveLength(1);
    const [stored] = await db.select().from(messages);
    expect(stored).toMatchObject({ direction: 'in', author: 'client', body: 'Сколько стоит?' });
  });

  it('orders the thread without opening a live reply window', async () => {
    const sentAt = new Date(1_770_000_000 * 1_000);

    await applyHistoryChunk(db, numberId, chunk());

    const [conversation] = await db.select().from(conversations);
    expect(conversation!.lastMessageAt).toEqual(sentAt);
    expect(conversation!.lastInboundAt).toBeNull();
  });

  it('preserves an existing live reply window when newer history arrives', async () => {
    await applyHistoryChunk(db, numberId, chunk());
    const [conversation] = await db.select().from(conversations);
    const liveInboundAt = new Date('2026-02-10T12:00:00.000Z');
    await db
      .update(conversations)
      .set({ lastInboundAt: liveInboundAt })
      .where(eq(conversations.id, conversation!.id));

    await applyHistoryChunk(
      db,
      numberId,
      chunk({
        messages: [
          raw({
            key: { id: 'old.newer', remoteJid: JID, fromMe: false },
            messageTimestamp: 1_771_000_000,
          }),
        ],
      }),
    );

    const [updated] = await db.select().from(conversations);
    expect(updated!.lastInboundAt).toEqual(liveInboundAt);
    expect(updated!.lastMessageAt).toEqual(new Date(1_771_000_000 * 1_000));
  });

  it('never runs a turn for an imported message', async () => {
    // `applyHistoryChunk` takes no model at all: the type is the guarantee, and this test
    // is what stops someone adding one later "for symmetry".
    const client = fakeLinked();
    const errors: string[] = [];
    registerLinkedHistory(db, { onError: (m) => errors.push(m) }, client);

    client.emit({ type: 'history', numberId, chunk: chunk() });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(await db.select().from(messages)).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it('reports what each chunk carried, so a phone that sent nothing is visible', async () => {
    const client = fakeLinked();
    const reports: { messages: number; contacts: number; progress: number | null; received: number; saved: number; duplicates: number; excluded: number; skippedUnresolved: number }[] = [];
    registerLinkedHistory(db, { onImported: (report) => reports.push(report) }, client);

    client.emit({ type: 'history', numberId, chunk: { ...chunk(), progress: 40 } });
    client.emit({ type: 'history', numberId, chunk: { messages: [], contacts: [] } });
    await until(() => reports.length === 2);

    expect(reports).toEqual([
      { messages: 1, contacts: 0, progress: 40, received: 1, saved: 1, duplicates: 0, excluded: 0, skippedUnresolved: 0 },
      { messages: 0, contacts: 0, progress: null, received: 0, saved: 0, duplicates: 0, excluded: 0, skippedUnresolved: 0 },
    ]);
  });

  it('does not import a chunk already stored by the archive worker', async () => {
    const client = fakeLinked();
    const reports: unknown[] = [];
    registerLinkedHistory(db, { onImported: (report) => reports.push(report) }, client);

    client.emit({ type: 'history', numberId, chunk: chunk({ alreadyStored: true }) });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(await db.select().from(messages)).toHaveLength(0);
    expect(reports).toEqual([]);
  });

  it('learns LID mappings before importing an earlier outgoing line', async () => {
    await applyHistoryChunk(
      db,
      numberId,
      chunk({
        messages: [
          raw({
            key: { id: 'old.out', remoteJid: LID, fromMe: true, senderPn: '77010000000@s.whatsapp.net' },
            message: { conversation: 'Ответ с телефона' },
          }),
          raw({ key: { id: 'old.in', remoteJid: LID, fromMe: false, senderPn: JID } }),
        ],
      }),
    );

    expect((await db.select().from(messages)).map((message) => message.waMessageId).sort()).toEqual([
      'old.in',
      'old.out',
    ]);
    expect(await db.select().from(conversations)).toHaveLength(1);
  });

  it('reports how many unresolved LID history messages were skipped', async () => {
    const client = fakeLinked();
    const errors: string[] = [];
    const reports: { skippedUnresolved: number }[] = [];
    registerLinkedHistory(db, { onError: (message) => errors.push(message), onImported: (report) => reports.push(report) }, client);

    client.emit({
      type: 'history',
      numberId,
      chunk: chunk({ messages: [raw({ key: { id: 'old.unknown', remoteJid: LID, fromMe: true } })] }),
    });
    await until(() => reports.length === 1);

    expect(reports[0]!.skippedUnresolved).toBe(1);
    expect(errors.join(' ')).toContain('1 history messages were not stored');
  });

  it('does not download a file during the import', async () => {
    const client = fakeLinked();
    registerLinkedHistory(db, {}, client);

    client.emit({
      type: 'history',
      numberId,
      chunk: chunk({
        messages: [
          raw({
            key: { id: 'old.2', remoteJid: JID, fromMe: false },
            message: { imageMessage: { caption: 'вот такой', mimetype: 'image/jpeg' } },
          }),
        ],
      }),
    });
    await new Promise((r) => setTimeout(r, 30));

    expect(client.calls.filter((c) => c.method === 'downloadMedia')).toHaveLength(0);
    const [stored] = await db.select().from(messages);
    expect(stored).toMatchObject({ kind: 'image', body: 'вот такой', mediaPath: null });
    // The bytes are not here, but the way to fetch them is: without the message itself the
    // photo could never be opened, because WhatsApp hands files over by key, not by id.
    expect(stored?.mediaRef).toMatchObject({ key: { id: 'old.2' } });
    expect(stored?.mediaMime).toBe('image/jpeg');
  });

  it('imports the same chunk twice without duplicating a message', async () => {
    await applyHistoryChunk(db, numberId, chunk());
    await applyHistoryChunk(db, numberId, chunk());

    expect(await db.select().from(messages)).toHaveLength(1);
  });

  it('fills a contact name only where the cabinet has none', async () => {
    await db.insert(contacts).values({ agentId, phone: '77085807932', name: 'Айгерим (постоянная)' });

    await applyHistoryChunk(
      db,
      numberId,
      chunk({ contacts: [{ id: JID, name: 'Айгерим' }], messages: [] }),
    );

    expect((await db.select().from(contacts))[0]!.name).toBe('Айгерим (постоянная)');
  });

  it('takes the phone book name when the cabinet has none', async () => {
    await applyHistoryChunk(
      db,
      numberId,
      chunk({ contacts: [{ id: JID, notify: 'Айгерим' }], messages: [] }),
    );

    expect((await db.select().from(contacts))[0]!.name).toBe('Айгерим');
  });

  it('skips group chats in a chunk', async () => {
    await applyHistoryChunk(
      db,
      numberId,
      chunk({
        contacts: [{ id: '120363@g.us', name: 'Мастерская' }],
        messages: [raw({ key: { id: 'old.3', remoteJid: '120363@g.us' } })],
      }),
    );

    expect(await db.select().from(messages)).toHaveLength(0);
    expect(await db.select().from(contacts)).toHaveLength(0);
  });

  it('moves the progress forward and never back', async () => {
    await applyHistoryChunk(db, numberId, chunk({ messages: [], progress: 40 }));
    await applyHistoryChunk(db, numberId, chunk({ messages: [], progress: 10 }));

    const [row] = await db.select().from(whatsappNumbers).where(eq(whatsappNumbers.id, numberId));
    expect(row!.historyProgress).toBe(40);
  });

  it('does nothing for a number that no longer exists', async () => {
    await db.delete(whatsappNumbers).where(eq(whatsappNumbers.id, numberId));

    await expect(applyHistoryChunk(db, numberId, chunk())).resolves.toBeUndefined();
    expect(randomBytes(1).length).toBe(1);
  });
});

describe('the operator alert echo in history', () => {
  it("skips the socket's own appended alert to the operator and still imports the rest", async () => {
    await db.update(agents).set({ operatorNotifyPhone: '77716944499' }).where(eq(agents.id, agentId));
    const alert = raw({
      key: { id: 'alert.1', remoteJid: '77716944499@s.whatsapp.net', fromMe: true },
      message: { conversation: 'Нужен оператор' },
    });

    const report = await applyHistoryChunkWithReport(db, numberId, chunk({ messages: [alert, raw()] }));

    expect(report).toMatchObject({ received: 2, saved: 1, excluded: 1 });
    const phones = (await db.select().from(contacts)).map((contact) => contact.phone);
    expect(phones).toEqual(['77085807932']);
    expect(await db.select().from(conversations)).toHaveLength(1);
  });
});
