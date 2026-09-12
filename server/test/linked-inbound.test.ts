import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  agents,
  aiReplies,
  contacts,
  conversations,
  messages,
  notes,
  whatsappNumbers,
} from '../src/db/schema.js';
import { createAccountWithOwner } from '../src/lib/provision.js';
import { encryptSecret } from '../src/lib/secret-box.js';
import {
  applyMessage,
  type LinkedInboundDeps,
} from '../src/lib/whatsapp/linked/inbound.js';
import { forgetLids } from '../src/lib/whatsapp/linked/lid-directory.js';
import { jidToLid, jidToPhone, normalize } from '../src/lib/whatsapp/linked/normalize.js';
import type { RawLinkedMessage } from '../src/lib/whatsapp/linked/client.js';
import { fakeGraph } from './helpers/fake-graph.js';
import { fakeLinked } from './helpers/fake-linked.js';
import { fakeModel } from './helpers/fake-model.js';
import { withDb } from './helpers/db.js';

/**
 * What the phone's socket brings, and what the cabinet does with it.
 *
 * The rows are written by the same code the Cloud API path uses, so these tests are about
 * the two things only this pipeline decides: what counts as a message at all, and what a
 * line the owner sent from their own handset means.
 */

let db: Awaited<ReturnType<typeof withDb>>;
let agentId: string;
let numberId: string;
let deps: LinkedInboundDeps;
let errors: string[];

const JID = '77085807932@s.whatsapp.net';
const LID = '47536731594988@lid';

function raw(over: Partial<RawLinkedMessage> = {}): RawLinkedMessage {
  return {
    key: { id: 'wa.1', remoteJid: JID, fromMe: false },
    messageTimestamp: 1_789_000_000,
    pushName: 'Айгерим',
    message: { conversation: 'Сколько стоит экслибрис?' },
    ...over,
  };
}

beforeEach(async () => {
  forgetLids();
  db = await withDb();
  errors = [];
  const { accountId } = await createAccountWithOwner(db, {
    company: 'Sealhouse',
    email: 'owner@example.com',
    name: 'Владелец',
    initials: 'ВЛ',
    password: 'correct-horse-battery',
  });
  const [agent] = await db
    .insert(agents)
    .values({ accountId, name: 'Sealhouse', responseMode: 'live' })
    .returning();
  agentId = agent!.id;
  const [number] = await db
    .insert(whatsappNumbers)
    .values({
      agentId,
      displayPhone: '+7 708 580 79 32',
      connectionKind: 'linked',
      linkedJid: '77085807932@s.whatsapp.net',
      linkedState: 'open',
    })
    .returning();
  numberId = number!.id;

  deps = {
    model: fakeModel(),
    graph: fakeGraph(),
    linked: fakeLinked(),
    key: randomBytes(32),
    mediaDir: await mkdtemp(join(tmpdir(), 'rakurs-media-')),
    onError: (message) => errors.push(message),
  };
});

describe('jidToPhone', () => {
  it('reads the number out of a jid, device suffix and all', () => {
    expect(jidToPhone('77085807932@s.whatsapp.net')).toBe('77085807932');
    expect(jidToPhone('77085807932:12@s.whatsapp.net')).toBe('77085807932');
  });

  it('answers null for anything that is not one person', () => {
    expect(jidToPhone('120363@g.us')).toBeNull();
    expect(jidToPhone('status@broadcast')).toBeNull();
    expect(jidToPhone(null)).toBeNull();
  });

  it('reads a LID without treating it as a phone number', () => {
    expect(jidToPhone(LID)).toBeNull();
    expect(jidToLid('47536731594988:3@lid')).toBe('47536731594988');
  });
});

describe('normalize', () => {
  it('reads a plain text message', () => {
    expect(normalize(raw())).toMatchObject({ kind: 'text', body: 'Сколько стоит экслибрис?' });
  });

  it('reads an extended text message', () => {
    const line = normalize(raw({ message: { extendedTextMessage: { text: 'а на казахском?' } } }));
    expect(line).toMatchObject({ kind: 'text', body: 'а на казахском?' });
  });

  it('keeps a photo caption as the message text', () => {
    // A photo of a stamp with «такой размер?» under it is one question. Dropping the
    // caption leaves the agent answering a blank image.
    const line = normalize(raw({ message: { imageMessage: { caption: 'такой размер?' } } }));
    expect(line).toMatchObject({ kind: 'image', body: 'такой размер?', hasMedia: true });
  });

  it('marks a voice note as media with no text', () => {
    const line = normalize(raw({ message: { audioMessage: { mimetype: 'audio/ogg' } } }));
    expect(line).toMatchObject({ kind: 'audio', body: null, hasMedia: true });
  });

  it('calls an unrenderable type unsupported rather than empty text', () => {
    const line = normalize(raw({ message: { pollCreationMessage: {} } as never }));
    expect(line).toMatchObject({ kind: 'unsupported', body: null, hasMedia: false });
  });

  it('drops a group message', () => {
    expect(normalize(raw({ key: { id: 'wa.1', remoteJid: '120363@g.us' } }))).toBeNull();
  });

  it('drops a status broadcast', () => {
    expect(normalize(raw({ key: { id: 'wa.1', remoteJid: 'status@broadcast' } }))).toBeNull();
  });

  it('drops protocol and reaction traffic', () => {
    expect(normalize(raw({ message: { protocolMessage: {} } }))).toBeNull();
    expect(normalize(raw({ message: { reactionMessage: {} } }))).toBeNull();
  });

  it('reads a timestamp handed over as a Long', () => {
    const line = normalize(raw({ messageTimestamp: { toNumber: () => 1_789_000_000 } }));
    expect(line!.sentAt.toISOString()).toBe(new Date(1_789_000_000_000).toISOString());
  });

  it('resolves an outgoing LID only after that number learned its customer', () => {
    const inbound = raw({ key: { id: 'wa.lid.in', remoteJid: LID, fromMe: false, senderPn: JID } });
    const outbound = raw({ key: { id: 'wa.lid.out', remoteJid: LID, fromMe: true } });

    expect(normalize(outbound, 'number-a')).toBeNull();
    expect(normalize(inbound, 'number-a')).toMatchObject({ from: '77085807932' });
    expect(normalize(outbound, 'number-a')).toMatchObject({ from: '77085807932' });
    expect(normalize(outbound, 'number-b')).toBeNull();
  });
});

describe('linked inbound', () => {
  it('records inbound ad attribution once and ignores outbound ad context', async () => {
    const client = fakeLinked();
    const ad = (id: string, fromMe = false): RawLinkedMessage => raw({
      key: { id, remoteJid: JID, fromMe },
      message: { extendedTextMessage: { text: 'Ad response', contextInfo: {
        externalAdReply: { sourceId: id, sourceType: 'ad', title: 'Custom stamp',
          body: 'Made to order', ctwaClid: `click-${id}` },
      } } },
    });
    await applyMessage(db, deps, client, numberId, ad('outbound', true));
    expect((await db.select().from(conversations))[0]?.referralSeenAt).toBeNull();
    await applyMessage(db, deps, client, numberId, ad('first'));
    await applyMessage(db, deps, client, numberId, ad('second'));
    await applyMessage(db, deps, client, numberId, ad('first'));
    expect((await db.select().from(conversations))[0]).toMatchObject({
      adSourceId: 'first', adSourceType: 'ad', adHeadline: 'Custom stamp',
      adBody: 'Made to order', ctwaClid: 'click-first', referralSeenAt: expect.any(Date),
    });
  });

  it('stores an incoming message and answers it', async () => {
    const client = fakeLinked();

    await applyMessage(db, deps, client, numberId, raw());

    const [stored] = await db.select().from(messages);
    expect(stored).toMatchObject({ direction: 'in', author: 'client', kind: 'text' });
    const [contact] = await db.select().from(contacts);
    expect(contact).toMatchObject({ phone: '77085807932', name: 'Айгерим' });
  });

  it('stores a denied Linked message without starting automation', async () => {
    const [selected] = await db
      .insert(contacts)
      .values({ agentId, phone: '77770000000', name: 'Тестовый клиент' })
      .returning();
    await db
      .update(agents)
      .set({
        aiEnabled: true,
        responseMode: 'test',
        testContactId: selected!.id,
        openrouterKey: encryptSecret('model-key', deps.key, agentId),
      })
      .where(eq(agents.id, agentId));
    const deniedModel = fakeModel(
      JSON.stringify({
        reply: 'Позову коллегу.',
        stageId: null,
        fields: {},
        handoff: { reason: 'клиент просит человека' },
        usedItemIds: [],
      }),
    );
    const outboundLinked = deps.linked as ReturnType<typeof fakeLinked>;
    deps.model = deniedModel;
    outboundLinked.setOpen(numberId, true);
    let crmCalls = 0;
    deps.crm = async () => {
      crmCalls += 1;
      return false;
    };

    await applyMessage(db, deps, fakeLinked(), numberId, raw());

    expect(await db.select().from(messages)).toHaveLength(1);
    expect(deniedModel.calls).toHaveLength(0);
    expect(crmCalls).toBe(0);
    expect(outboundLinked.calls.filter((call) => call.method === 'sendText')).toHaveLength(0);
    expect((await db.select().from(conversations))[0]?.aiEnabled).toBe(true);
    expect(await db.select().from(notes)).toHaveLength(0);
    expect(await db.select().from(aiReplies)).toHaveLength(0);
  });

  it('stores a live message from a LID-addressed chat', async () => {
    const client = fakeLinked();

    await applyMessage(db, deps, client, numberId, raw({
      key: { id: 'wa.lid', remoteJid: LID, fromMe: false, senderPn: JID },
    }));

    expect((await db.select().from(messages))[0]).toMatchObject({ direction: 'in', author: 'client' });
    expect((await db.select().from(contacts))[0]).toMatchObject({ phone: '77085807932' });
    expect(errors).toEqual([]);
  });

  it('reports an unresolved live LID message', async () => {
    await applyMessage(db, deps, fakeLinked(), numberId, raw({
      key: { id: 'wa.unknown', remoteJid: LID, fromMe: true },
    }));

    expect(await db.select().from(messages)).toHaveLength(0);
    expect(errors.join(' ')).toContain('the contact phone number is unknown');
  });

  it('mirrors what the owner sent from the phone as an outgoing line', async () => {
    const client = fakeLinked();

    await applyMessage(db, deps, client, numberId, raw({
      key: { id: 'wa.2', remoteJid: JID, fromMe: true },
      message: { conversation: 'Здравствуйте! Сейчас посчитаю.' },
    }));

    const [stored] = await db.select().from(messages);
    expect(stored).toMatchObject({ direction: 'out', author: 'phone', status: 'sent' });
  });

  it('never names the contact after the owner', async () => {
    // `pushName` on an outgoing line is the owner's own name. Writing it onto the contact
    // would rename every customer the owner answered first.
    const client = fakeLinked();

    await applyMessage(db, deps, client, numberId, raw({
      key: { id: 'wa.2', remoteJid: JID, fromMe: true },
      pushName: 'Sealhouse',
    }));

    const [contact] = await db.select().from(contacts);
    expect(contact!.name).toBeNull();
  });

  it('hands the thread to the human when the owner answers from the phone', async () => {
    const client = fakeLinked();
    await applyMessage(db, deps, client, numberId, raw());

    await applyMessage(db, deps, client, numberId, raw({
      key: { id: 'wa.2', remoteJid: JID, fromMe: true },
      message: { conversation: 'уже отвечаю' },
    }));

    const [conversation] = await db.select().from(conversations);
    expect(conversation!.aiEnabled).toBe(false);
  });

  it('ignores a group message entirely', async () => {
    const client = fakeLinked();

    await applyMessage(db, deps, client, numberId, raw({
      key: { id: 'wa.3', remoteJid: '120363@g.us' },
    }));

    expect(await db.select().from(messages)).toHaveLength(0);
    expect(await db.select().from(conversations)).toHaveLength(0);
  });

  it('downloads a photo once, however often it is replayed', async () => {
    const client = fakeLinked();
    const photo = raw({
      key: { id: 'wa.4', remoteJid: JID, fromMe: false },
      message: { imageMessage: { caption: 'вот такой', mimetype: 'image/jpeg' } },
    });

    await applyMessage(db, deps, client, numberId, photo);
    await applyMessage(db, deps, client, numberId, photo);

    expect(client.calls.filter((c) => c.method === 'downloadMedia')).toHaveLength(1);
    const [stored] = await db.select().from(messages);
    expect(stored!.mediaPath).toMatch(/\.jpg$/);
    expect(await readFile(join(deps.mediaDir, stored!.mediaPath!))).toEqual(client.media);
  });

  it('keeps the message when its file cannot be downloaded', async () => {
    const client = fakeLinked({
      downloadMedia: async () => {
        throw new Error('phone went away mid-transfer');
      },
    });

    await applyMessage(db, deps, client, numberId, raw({
      key: { id: 'wa.5', remoteJid: JID, fromMe: false },
      message: { imageMessage: { caption: 'вот такой', mimetype: 'image/jpeg' } },
    }));

    const [stored] = await db.select().from(messages);
    expect(stored).toMatchObject({ kind: 'image', body: 'вот такой', mediaPath: null });
    expect(errors.join(' ')).toContain('не скачался');
  });

  it('stores a replayed message once', async () => {
    const client = fakeLinked();

    await applyMessage(db, deps, client, numberId, raw());
    await applyMessage(db, deps, client, numberId, raw());

    expect(await db.select().from(messages)).toHaveLength(1);
  });

  it('moves the conversation clocks forward for an incoming line', async () => {
    const client = fakeLinked();

    await applyMessage(db, deps, client, numberId, raw());

    const [conversation] = await db.select().from(conversations);
    expect(conversation!.lastInboundAt).not.toBeNull();
    expect(conversation!.lastMessageAt).not.toBeNull();
  });

  it('does not move lastInboundAt for a line the owner sent', async () => {
    // The 24-hour window is Meta's, but `lastInboundAt` also answers «did the customer
    // write», and the owner writing is not the customer writing.
    const client = fakeLinked();

    await applyMessage(db, deps, client, numberId, raw({
      key: { id: 'wa.6', remoteJid: JID, fromMe: true },
    }));

    const [conversation] = await db.select().from(conversations);
    expect(conversation!.lastInboundAt).toBeNull();
    expect(conversation!.lastMessageAt).not.toBeNull();
  });

  it('does nothing when the number has been deleted under the socket', async () => {
    const client = fakeLinked();
    await db.delete(whatsappNumbers).where(eq(whatsappNumbers.id, numberId));

    await expect(applyMessage(db, deps, client, numberId, raw())).resolves.toBeUndefined();
    expect(await db.select().from(messages)).toHaveLength(0);
  });

  it('does not learn a LID mapping after its linked number was deleted', async () => {
    const client = fakeLinked();
    await db.delete(whatsappNumbers).where(eq(whatsappNumbers.id, numberId));

    await applyMessage(db, deps, client, numberId, raw({
      key: { id: 'wa.deleted', remoteJid: LID, fromMe: false, senderPn: JID },
    }));

    expect(normalize(raw({ key: { id: 'wa.out', remoteJid: LID, fromMe: true } }), numberId)).toBeNull();
  });
});
