import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { agents, contacts, conversations, messages, whatsappNumbers } from '../src/db/schema.js';
import { createAccountWithOwner } from '../src/lib/provision.js';
import type { RawLinkedHistory, RawLinkedMessage } from '../src/lib/whatsapp/linked/client.js';
import { applyHistoryChunk } from '../src/lib/whatsapp/linked/history.js';
import { registerLinkedHistory } from '../src/lib/whatsapp/linked/history.js';
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
  it('writes the contact, the thread and the message', async () => {
    await applyHistoryChunk(db, numberId, chunk());

    expect(await db.select().from(contacts)).toHaveLength(1);
    expect(await db.select().from(conversations)).toHaveLength(1);
    const [stored] = await db.select().from(messages);
    expect(stored).toMatchObject({ direction: 'in', author: 'client', body: 'Сколько стоит?' });
  });

  it('never runs a turn for an imported message', async () => {
    // `applyHistoryChunk` takes no model at all: the type is the guarantee, and this test
    // is what stops someone adding one later "for symmetry".
    const client = fakeLinked();
    const errors: string[] = [];
    registerLinkedHistory(db, { onError: (m) => errors.push(m) }, client);

    client.emit({ type: 'history', numberId, chunk: chunk() });
    await new Promise((r) => setTimeout(r, 30));

    expect(await db.select().from(messages)).toHaveLength(1);
    expect(errors).toEqual([]);
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
