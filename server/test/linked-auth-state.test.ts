import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { agents, linkedSessionKeys, whatsappNumbers } from '../src/db/schema.js';
import { createAccountWithOwner } from '../src/lib/provision.js';
import { linkedAuthState } from '../src/lib/whatsapp/linked/auth-state.js';
import { withDb } from './helpers/db.js';

/**
 * Baileys ships `useMultiFileAuthState` — a JSON file per key — as its reference
 * implementation. This is the same contract against a table, and these tests are what
 * says the two agree where it matters: credentials survive a reopen, signal keys survive
 * as Buffers rather than as `{"type":"Buffer"}` objects, a null value deletes, and
 * nothing readable is left in the database for someone holding a dump.
 */

let db: Awaited<ReturnType<typeof withDb>>;
let numberId: string;
const key = randomBytes(32);

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
  const [number] = await db
    .insert(whatsappNumbers)
    .values({
      agentId: agent!.id,
      displayPhone: '+7 700 000 00 00',
      connectionKind: 'linked',
      linkedJid: '77000000000@s.whatsapp.net',
      linkedState: 'pairing',
    })
    .returning();
  numberId = number!.id;
});

describe('linked auth state', () => {
  it('starts a session that has not registered yet', async () => {
    const auth = await linkedAuthState(db, key, numberId);

    expect(auth.state.creds.registered).toBe(false);
  });

  it('round-trips credentials through the table', async () => {
    const first = await linkedAuthState(db, key, numberId);
    first.state.creds.me = { id: '77000000000@s.whatsapp.net', name: 'Sealhouse' };
    await first.saveCreds();

    const second = await linkedAuthState(db, key, numberId);

    expect(second.state.creds.me?.id).toBe('77000000000@s.whatsapp.net');
  });

  it('keeps a signal key a Buffer across a reopen', async () => {
    // The whole reason BufferJSON exists. Without the replacer and reviver a key comes back
    // as {"type":"Buffer","data":[…]} and the first message fails inside libsignal with an
    // error that says nothing about serialization.
    const auth = await linkedAuthState(db, key, numberId);
    await auth.state.keys.set({ 'pre-key': { '7': { public: Buffer.from([1, 2, 3]) } } } as never);

    const reopened = await linkedAuthState(db, key, numberId);
    const got = (await reopened.state.keys.get('pre-key', ['7'])) as Record<
      string,
      { public: Buffer }
    >;

    expect(Buffer.isBuffer(got['7']!.public)).toBe(true);
    expect(got['7']!.public).toEqual(Buffer.from([1, 2, 3]));
  });

  it('reads many keys in one pass', async () => {
    const auth = await linkedAuthState(db, key, numberId);
    await auth.state.keys.set({
      'pre-key': { '1': { public: Buffer.from([1]) }, '2': { public: Buffer.from([2]) } },
    } as never);

    const got = await auth.state.keys.get('pre-key', ['1', '2', '3']);

    expect(Object.keys(got).sort()).toEqual(['1', '2']);
  });

  it('deletes a key written as null', async () => {
    const auth = await linkedAuthState(db, key, numberId);
    await auth.state.keys.set({ 'pre-key': { '7': { public: Buffer.from([1]) } } } as never);

    await auth.state.keys.set({ 'pre-key': { '7': null } } as never);

    expect(await auth.state.keys.get('pre-key', ['7'])).toEqual({});
  });

  it('leaves nothing a database reader can use', async () => {
    const auth = await linkedAuthState(db, key, numberId);
    auth.state.creds.me = { id: '77000000000@s.whatsapp.net', name: 'Sealhouse' };
    await auth.saveCreds();

    const [row] = await db
      .select()
      .from(linkedSessionKeys)
      .where(eq(linkedSessionKeys.whatsappNumberId, numberId));

    expect(row!.value).not.toContain('77000000000');
    expect(row!.value).not.toContain('Sealhouse');
  });

  it('treats a row it cannot decrypt as an absent key', async () => {
    // A rotated credentials key, or a row someone edited. Throwing here would take down the
    // socket on every reconnect; answering «no such key» makes Baileys ask for a new pairing,
    // which is the truth about what happened.
    const auth = await linkedAuthState(db, key, numberId);
    await auth.state.keys.set({ 'pre-key': { '7': { public: Buffer.from([1]) } } } as never);
    await db
      .update(linkedSessionKeys)
      .set({ value: 'not.valid.ciphertext' })
      .where(eq(linkedSessionKeys.whatsappNumberId, numberId));

    expect(await auth.state.keys.get('pre-key', ['7'])).toEqual({});
  });

  it('refuses a value encrypted for another number', async () => {
    const auth = await linkedAuthState(db, key, numberId);
    await auth.saveCreds();
    const [row] = await db.select().from(linkedSessionKeys);
    const [other] = await db
      .insert(whatsappNumbers)
      .values({
        agentId: (await db.select().from(agents))[0]!.id,
        displayPhone: '+7 700 000 00 01',
        connectionKind: 'linked',
        linkedJid: '77000000001@s.whatsapp.net',
        linkedState: 'pairing',
      })
      .returning();
    await db.insert(linkedSessionKeys).values({
      whatsappNumberId: other!.id,
      category: 'creds',
      keyId: 'me',
      value: row!.value,
    });

    const stolen = await linkedAuthState(db, key, other!.id);

    // Fresh credentials, not the ones copied over: the aad binds a value to its row.
    expect(stolen.state.creds.me).toBeUndefined();
  });

  it('clear removes every row for the number', async () => {
    const auth = await linkedAuthState(db, key, numberId);
    await auth.saveCreds();
    await auth.state.keys.set({ 'pre-key': { '7': { public: Buffer.from([1]) } } } as never);

    await auth.clear();

    expect(
      await db
        .select()
        .from(linkedSessionKeys)
        .where(eq(linkedSessionKeys.whatsappNumberId, numberId)),
    ).toHaveLength(0);
  });
});
