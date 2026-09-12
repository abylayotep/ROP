import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api/server.js';
import { agents, linkedHistoryPackets, whatsappNumbers } from '../src/db/schema.js';
import { createAccountWithOwner } from '../src/lib/provision.js';
import { withDb } from './helpers/db.js';
import { testEnv } from './helpers/env.js';
import { fakeLinked } from './helpers/fake-linked.js';

const PASSWORD = 'correct-horse-battery';
let app: FastifyInstance;
let db: Awaited<ReturnType<typeof withDb>>;
let agentId: string;
let numberId: string;
let ownerJar: Record<string, string>;

async function login(email: string) {
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: PASSWORD } });
  const cookie = response.cookies[0]!;
  return { [cookie.name]: cookie.value };
}

beforeEach(async () => {
  db = await withDb();
  app = buildServer(testEnv(), db, { linked: fakeLinked() });
  await app.ready();
  const owner = await createAccountWithOwner(db, {
    company: 'Archive', email: 'owner@archive.test', name: 'Owner', initials: 'OW', password: PASSWORD,
  });
  const [agent] = await db.insert(agents).values({ accountId: owner.accountId, name: 'Agent' }).returning();
  agentId = agent!.id;
  const [number] = await db.insert(whatsappNumbers).values({
    agentId, displayPhone: '+7700', connectionKind: 'linked', linkedJid: '7700@s.whatsapp.net', linkedState: 'open',
  }).returning();
  numberId = number!.id;
  ownerJar = await login('owner@archive.test');
});

afterEach(async () => app.close());

describe('WhatsApp history archive API', () => {
  it('lists safe packet metadata without encrypted payloads', async () => {
    await db.insert(linkedHistoryPackets).values({
      numberId, digest: 'digest-1', notification: 'encrypted-notification', payload: 'encrypted-payload',
      status: 'partial', attempts: 2, errorCode: 'unresolved_lid',
      counts: { received: 20, saved: 8, duplicates: 1, excluded: 2, skippedUnresolved: 9 },
      expiresAt: new Date(Date.now() + 60_000),
    });

    const response = await app.inject({
      method: 'GET', url: `/api/agents/${agentId}/whatsapp/history/archive`, cookies: ownerJar,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([expect.objectContaining({
      numberId, status: 'partial', attempts: 2, errorCode: 'unresolved_lid', canReplay: true,
      counts: { received: 20, saved: 8, duplicates: 1, excluded: 2, skippedUnresolved: 9 },
    })]);
    expect(response.body).not.toContain('encrypted-notification');
    expect(response.body).not.toContain('encrypted-payload');
  });

  it('queues an eligible packet for replay and rejects expired packets', async () => {
    const [ready] = await db.insert(linkedHistoryPackets).values({
      numberId, digest: 'digest-ready', payload: 'encrypted-payload', status: 'failed', attempts: 3,
      errorCode: 'download_failed', expiresAt: new Date(Date.now() + 60_000),
    }).returning();
    const [expired] = await db.insert(linkedHistoryPackets).values({
      numberId, digest: 'digest-expired', payload: 'encrypted-payload', status: 'partial',
      expiresAt: new Date(Date.now() - 60_000),
    }).returning();

    const replay = await app.inject({
      method: 'POST', url: `/api/agents/${agentId}/whatsapp/history/archive/${ready!.id}/replay`, cookies: ownerJar,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ id: ready!.id, status: 'queued', attempts: 0, errorCode: null });

    const stale = await app.inject({
      method: 'POST', url: `/api/agents/${agentId}/whatsapp/history/archive/${expired!.id}/replay`, cookies: ownerJar,
    });
    expect(stale.statusCode).toBe(409);
  });

  it('does not expose or replay another tenant packet', async () => {
    const stranger = await createAccountWithOwner(db, {
      company: 'Other', email: 'other-archive@test.dev', name: 'Other', initials: 'OT', password: PASSWORD,
    });
    const [otherAgent] = await db.insert(agents).values({ accountId: stranger.accountId, name: 'Other agent' }).returning();
    const [otherNumber] = await db.insert(whatsappNumbers).values({
      agentId: otherAgent!.id, displayPhone: '+7800', connectionKind: 'linked',
      linkedJid: '7800@s.whatsapp.net', linkedState: 'open',
    }).returning();
    const [packet] = await db.insert(linkedHistoryPackets).values({
      numberId: otherNumber!.id, digest: 'other', payload: 'secret', status: 'failed',
      expiresAt: new Date(Date.now() + 60_000),
    }).returning();

    const list = await app.inject({ method: 'GET', url: `/api/agents/${agentId}/whatsapp/history/archive`, cookies: ownerJar });
    const replay = await app.inject({
      method: 'POST', url: `/api/agents/${agentId}/whatsapp/history/archive/${packet!.id}/replay`, cookies: ownerJar,
    });
    expect(list.json()).toEqual([]);
    expect(replay.statusCode).toBe(404);
  });
});
