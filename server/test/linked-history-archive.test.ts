import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, expect, it } from 'vitest';
import { proto } from '@whiskeysockets/baileys';
import { agents, linkedHistoryPackets, messages, whatsappNumbers } from '../src/db/schema.js';
import { createAccountWithOwner } from '../src/lib/provision.js';
import { decryptSecret } from '../src/lib/secret-box.js';
import { createHistoryArchive } from '../src/lib/whatsapp/linked/history-archive.js';
import { decodeHistoryPayload } from '../src/lib/whatsapp/linked/history-codec.js';
import { withDb } from './helpers/db.js';

let db: Awaited<ReturnType<typeof withDb>>;
let numberId: string;
const key = randomBytes(32);
const chunk = { contacts: [], messages: [{ key: { id: 'archived', remoteJid: '77012345678@s.whatsapp.net', fromMe: false },
  messageTimestamp: 1789000000, message: { conversation: 'Private customer question' } }] };
beforeEach(async () => {
  db = await withDb();
  const { accountId } = await createAccountWithOwner(db, { company: 'Archive', email: 'archive@example.com',
    name: 'Owner', initials: 'O', password: 'correct-horse-battery' });
  const [agent] = await db.insert(agents).values({ accountId, name: 'Archive' }).returning();
  const [number] = await db.insert(whatsappNumbers).values({ agentId: agent!.id, connectionKind: 'linked',
    displayPhone: '+77010000000', linkedJid: '77010000000@s.whatsapp.net', linkedState: 'open' }).returning();
  numberId = number!.id;
});

it('persists an encrypted notification before downloading and retains payload when decoding fails', async () => {
  const archive = createHistoryArchive(db, key, {
    download: async () => {
      const [row] = await db.select().from(linkedHistoryPackets);
      expect(row!.notification).not.toContain('private-download-key');
      expect(decryptSecret(row!.notification!, key, `history:${numberId}:${row!.id}:notification`)).toBe('private-download-key');
      return 'private-raw-payload';
    },
    decode: () => { throw new Error('Sensitive upstream details'); },
  });
  await archive.capture(numberId, 'private-download-key');
  await archive.drain();
  const [row] = await db.select().from(linkedHistoryPackets);
  expect(row!.status).toBe('failed');
  expect(row!.errorCode).toBe('processing_failed');
  expect(decryptSecret(row!.payload!, key, `history:${numberId}:${row!.id}:payload`)).toBe('private-raw-payload');
  expect(await db.select().from(messages)).toHaveLength(0);
});

it('deduplicates capture and replays persisted payload after restart without downloading or AI replies', async () => {
  const first = createHistoryArchive(db, key, { download: async () => 'raw', decode: () => chunk });
  await first.capture(numberId, 'notification');
  await first.capture(numberId, 'notification');
  await first.drain();
  let [row] = await db.select().from(linkedHistoryPackets);
  expect(row!.counts).toEqual({ received: 1, saved: 1, duplicates: 0, excluded: 0, skippedUnresolved: 0 });
  expect(await db.select().from(linkedHistoryPackets)).toHaveLength(1);
  await db.update(linkedHistoryPackets).set({ status: 'queued' }).where(eq(linkedHistoryPackets.id, row!.id));
  const restarted = createHistoryArchive(db, key, { download: async () => { throw new Error('Must not download again'); }, decode: () => chunk });
  await restarted.drain();
  [row] = await db.select().from(linkedHistoryPackets);
  expect(row!.status).toBe('done');
  expect(row!.counts).toEqual({ received: 1, saved: 0, duplicates: 1, excluded: 0, skippedUnresolved: 0 });
  expect(await db.select().from(messages)).toHaveLength(1);
});

it('expires raw data without deleting imported messages', async () => {
  const archive = createHistoryArchive(db, key, { download: async () => 'raw', decode: () => chunk });
  await archive.capture(numberId, 'notification');
  await archive.drain();
  await db.update(linkedHistoryPackets).set({ expiresAt: new Date(0) });
  await archive.drain();
  const [row] = await db.select().from(linkedHistoryPackets);
  expect(row).toMatchObject({ status: 'expired', notification: null, payload: null });
  expect(await db.select().from(messages)).toHaveLength(1);
});

it('retains unresolved messages and resolves them from a later mapping without another QR', async () => {
  let hasMapping = false;
  const archive = createHistoryArchive(db, key, { download: async () => 'raw', decode: () => ({
    ...chunk, messages: [{ ...chunk.messages[0]!, key: { id: 'lid-replay', remoteJid: '5555@lid', fromMe: false } }],
    phoneNumberToLidMappings: hasMapping ? [{ pnJid: '77012345678@s.whatsapp.net', lidJid: '5555@lid' }] : [],
  }) });
  await archive.capture(numberId, 'notification');
  await archive.drain();
  const [partial] = await db.select().from(linkedHistoryPackets);
  expect(partial!.status).toBe('partial');
  expect(partial!.payload).not.toBeNull();
  expect(partial!.counts).toEqual({ received: 1, saved: 0, duplicates: 0, excluded: 0, skippedUnresolved: 1 });
  hasMapping = true;
  await db.update(linkedHistoryPackets).set({ status: 'queued' });
  await archive.drain();
  expect((await db.select().from(linkedHistoryPackets))[0]!.status).toBe('done');
  expect(await db.select().from(messages)).toHaveLength(1);
});

it('recovers a stale processing lease and rejects ciphertext moved between packet identities', async () => {
  const archive = createHistoryArchive(db, key, { download: async () => 'raw', decode: () => chunk });
  await archive.capture(numberId, 'first');
  await db.update(linkedHistoryPackets).set({ status: 'processing', updatedAt: new Date(0) });
  await archive.drain();
  const [first] = await db.select().from(linkedHistoryPackets);
  expect(first!.status).toBe('done');
  await archive.capture(numberId, 'second');
  await db.update(linkedHistoryPackets).set({ payload: first!.payload }).where(eq(linkedHistoryPackets.status, 'queued'));
  await archive.drain();
  const rows = await db.select().from(linkedHistoryPackets);
  expect(rows.find(row => row.id !== first!.id)!.status).toBe('failed');
  expect(await db.select().from(messages)).toHaveLength(1);
});

it('rolls back message writes when a later line in the same packet fails', async () => {
  const archive = createHistoryArchive(db, key, { download: async () => 'raw', decode: () => ({
    ...chunk, messages: [...chunk.messages, { ...chunk.messages[0]!, key: { ...chunk.messages[0]!.key, id: 'broken' },
      messageTimestamp: { toNumber: () => { throw new Error('Invalid timestamp'); } } }],
  }) });
  await archive.capture(numberId, 'notification');
  await archive.drain();
  expect((await db.select().from(linkedHistoryPackets))[0]!.status).toBe('failed');
  expect(await db.select().from(messages)).toHaveLength(0);
});

it('keeps a successful import successful when a notification listener throws', async () => {
  const archive = createHistoryArchive(db, key, { download: async () => 'raw', decode: () => chunk,
    onImported: () => { throw new Error('Observer failed'); } });
  await archive.capture(numberId, 'notification');
  await archive.drain();
  expect((await db.select().from(linkedHistoryPackets))[0]!.status).toBe('done');
});

it('imports a raw protobuf packet with top-level LID mappings through the durable pipeline', async () => {
  const raw = proto.HistorySync.encode(proto.HistorySync.fromObject({ syncType: 2,
    phoneNumberToLidMappings: [{ pnJid: '77012345678@s.whatsapp.net', lidJid: '111@lid' }],
    conversations: [{ id: '111@lid', messages: [false, true].map((fromMe, index) => ({
      message: { key: { id: `protobuf-${index}`, remoteJid: '111@lid', fromMe },
        messageTimestamp: 1789000000 + index, message: { conversation: fromMe ? 'Answer' : 'Question' } },
    })) }],
  })).finish();
  const archive = createHistoryArchive(db, key, { download: async () => Buffer.from(raw).toString('base64'),
    decode: payload => decodeHistoryPayload(payload) });
  await archive.capture(numberId, 'notification');
  await archive.drain();
  expect((await db.select().from(linkedHistoryPackets))[0]!.counts).toEqual({ received: 2, saved: 2, duplicates: 0, excluded: 0, skippedUnresolved: 0 });
  const stored = await db.select().from(messages);
  expect(stored.map(row => row.author).sort()).toEqual(['client', 'phone']);
  expect(stored[0]!.sentAt.getTime()).toBe(1789000000000);
});

it('does not resurrect payload when retention expires during download', async () => {
  const archive = createHistoryArchive(db, key, { download: async () => {
    await db.update(linkedHistoryPackets).set({ expiresAt: new Date(0), status: 'expired', payload: null, notification: null });
    return 'raw';
  }, decode: () => chunk });
  await archive.capture(numberId, 'notification');
  await archive.drain();
  expect((await db.select().from(linkedHistoryPackets))[0]).toMatchObject({ status: 'expired', payload: null, notification: null });
  expect(await db.select().from(messages)).toHaveLength(0);
});
