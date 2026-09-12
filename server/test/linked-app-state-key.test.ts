import { randomBytes } from 'node:crypto';
import { proto } from '@whiskeysockets/baileys';
import { beforeEach, describe, expect, it } from 'vitest';
import { agents, whatsappNumbers } from '../src/db/schema.js';
import { linkedAuthState } from '../src/lib/whatsapp/linked/auth-state.js';
import { createAccountWithOwner } from '../src/lib/provision.js';
import { withDb } from './helpers/db.js';

let db: Awaited<ReturnType<typeof withDb>>;
let numberId: string;
const key = randomBytes(32);

beforeEach(async () => {
  db = await withDb();
  const { accountId } = await createAccountWithOwner(db, {
    company: 'Sealhouse',
    email: 'owner@example.com',
    name: 'Owner',
    initials: 'OW',
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
      linkedState: 'open',
    })
    .returning();
  numberId = number!.id;
});

describe('linked app-state key persistence', () => {
  it('restores protobuf key bytes after an encrypted database round-trip', async () => {
    const first = await linkedAuthState(db, key, numberId);
    const value = proto.Message.AppStateSyncKeyData.fromObject({
      keyData: Buffer.from([1, 2, 3]),
      fingerprint: { rawId: 7, currentIndex: 1, deviceIndexes: [1] },
      timestamp: 123,
    });
    await first.state.keys.set({ 'app-state-sync-key': { current: value } });

    const reopened = await linkedAuthState(db, key, numberId);
    const stored = (await reopened.state.keys.get('app-state-sync-key', ['current'])).current as
      | { keyData?: Uint8Array | null }
      | undefined;

    expect(stored?.keyData).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(stored!.keyData!)).toEqual(Buffer.from([1, 2, 3]));
  });
});
