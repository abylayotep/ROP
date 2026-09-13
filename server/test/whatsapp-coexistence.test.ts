import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { agents, whatsappNumbers } from '../src/db/schema.js';
import { createAccountWithOwner } from '../src/lib/provision.js';
import { decryptSecret } from '../src/lib/secret-box.js';
import { GraphError } from '../src/lib/whatsapp/graph.js';
import { withDb } from './helpers/db.js';
import { testEnv } from './helpers/env.js';
import { fakeGraph, type FakeGraph } from './helpers/fake-graph.js';
import { asCloudNumber } from '../src/lib/whatsapp/cloud-number.js';

const env = testEnv({ META_APP_ID: '1585667806534384', META_ES_CONFIG_ID: '777' });
const PASSWORD = 'correct-horse-battery';

let app: FastifyInstance;
let db: Awaited<ReturnType<typeof withDb>>;
let graph: FakeGraph;
let agentId: string;
let jar: Record<string, string>;

async function login(email: string) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: PASSWORD } });
  const cookie = res.cookies[0]!;
  return { [cookie.name]: cookie.value };
}

async function boot(overrides: Parameters<typeof fakeGraph>[0] = {}) {
  db = await withDb();
  graph = fakeGraph(overrides);
  app = buildServer(env, db, { graph });
  await app.ready();
  const { accountId } = await createAccountWithOwner(db, {
    company: 'Sealhouse',
    email: 'owner@example.com',
    name: 'Владелец',
    initials: 'ВЛ',
    password: PASSWORD,
  });
  const [agent] = await db.insert(agents).values({ accountId, name: 'Sealhouse' }).returning();
  agentId = agent!.id;
  jar = await login('owner@example.com');
}

beforeEach(() => boot());

const connect = (payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: `/api/agents/${agentId}/whatsapp/coexistence`, cookies: jar, payload });

describe('embedded signup setup', () => {
  it('gives the owner the app id and the configuration id, nothing secret', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/agents/${agentId}/whatsapp/embedded-signup`, cookies: jar });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ appId: '1585667806534384', configId: '777' });
    expect(res.body).not.toContain(env.META_APP_SECRET);
  });
});

describe('connecting the phone number', () => {
  it('exchanges the code, checks the number, subscribes, stores, and requests both syncs', async () => {
    const res = await connect({ code: 'AQD-code', wabaId: '932', phoneNumberId: '136', businessId: '877' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      phoneNumberId: '136',
      wabaId: '932',
      connectionKind: 'coexistence',
      subscribed: true,
      historyProgress: 0,
      syncError: null,
    });

    expect(graph.calls.map((c) => c.method)).toEqual([
      'exchangeCode',
      'listPhoneNumbers',
      'getPhoneNumber',
      'subscribeApp',
      'setWebhookOverride',
      'requestSmbAppData',
      'requestSmbAppData',
    ]);
    expect(graph.calls[0]!.args).toEqual(['AQD-code', '1585667806534384', env.META_APP_SECRET]);
    expect(graph.calls[4]!.args[2]).toMatchObject({ url: expect.stringContaining('/api/whatsapp/webhook') });
    expect(graph.calls[5]!.args[2]).toBe('smb_app_state_sync');
    expect(graph.calls[6]!.args[2]).toBe('history');

    const [row] = await db.select().from(whatsappNumbers);
    expect(row!.businessId).toBe('877');
    expect(row!.syncRequestedAt).not.toBeNull();
    // The deadline Meta stated at issue. Without it nothing in the product knows this
    // number has sixty days to live, and the first sign would be every send failing.
    expect(row!.tokenExpiresAt).toEqual(new Date('2026-11-10T09:00:00.000Z'));
    expect(decryptSecret(asCloudNumber(row!).accessToken, Buffer.from(env.CREDENTIALS_KEY, 'base64'), '136')).toBe('EAAB-business-token');
  });

  it('resolves the number from the WABA when Embedded Signup reported only the WABA', async () => {
    const res = await connect({ code: 'AQD-code', wabaId: '932' });

    expect(res.statusCode).toBe(200);
    expect(res.json().phoneNumberId).toBe('136');
    expect(graph.calls.map((c) => c.method)).toContain('listPhoneNumbers');
  });

  it('refuses when the WABA has several numbers and none was named', async () => {
    await boot({
      listPhoneNumbers: async () => [
        { id: '1', displayPhoneNumber: '+7 1', verifiedName: 'a', platformType: null, isOnBizApp: true },
        { id: '2', displayPhoneNumber: '+7 2', verifiedName: 'b', platformType: null, isOnBizApp: true },
      ],
    });

    const res = await connect({ code: 'AQD-code', wabaId: '932' });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('У аккаунта несколько номеров. Повторите подключение и выберите номер в окне Meta.');
    expect(await db.select().from(whatsappNumbers)).toHaveLength(0);
  });

  it('refuses a number that does not belong to the reported WABA', async () => {
    await boot({
      listPhoneNumbers: async () => [
        { id: '999', displayPhoneNumber: '+7 9', verifiedName: 'other', platformType: null, isOnBizApp: true },
      ],
    });

    const res = await connect({ code: 'AQD-code', wabaId: '932', phoneNumberId: '136' });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('Номер не принадлежит выбранному аккаунту WhatsApp Business');
    expect(graph.calls.map((c) => c.method)).not.toContain('subscribeApp');
    expect(await db.select().from(whatsappNumbers)).toHaveLength(0);
  });

  it('stores nothing when Meta rejects the code, and hides the secret', async () => {
    await boot({
      exchangeCode: async () => {
        throw new GraphError('Invalid verification code test-app-secret', 400, 100);
      },
    });

    const res = await connect({ code: 'stale', wabaId: '932', phoneNumberId: '136' });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('Meta не приняла подтверждение: Invalid verification code <токен скрыт>');
    expect(await db.select().from(whatsappNumbers)).toHaveLength(0);
  });

  it('refuses a number that is not on the phone app', async () => {
    await boot({
      getPhoneNumber: async () => ({
        id: '136',
        displayPhoneNumber: '+7 771',
        verifiedName: 'x',
        platformType: 'CLOUD_API',
        isOnBizApp: false,
      }),
    });

    const res = await connect({ code: 'AQD-code', wabaId: '932', phoneNumberId: '136' });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('Номер не подключён к приложению WhatsApp Business на телефоне');
    expect(await db.select().from(whatsappNumbers)).toHaveLength(0);
  });

  it('keeps the number and records the error when a sync request is refused', async () => {
    await boot({
      requestSmbAppData: async (_id, _t, syncType) => {
        if (syncType === 'history') throw new GraphError('History sync already requested', 400, 2593002);
        return { requestId: 'req-contacts' };
      },
    });

    const res = await connect({ code: 'AQD-code', wabaId: '932', phoneNumberId: '136' });

    expect(res.statusCode).toBe(200);
    expect(res.json().syncError).toBe('History sync already requested');
    const [row] = await db.select().from(whatsappNumbers);
    expect(row!.syncRequestedAt).toBeNull();
  });

  it('still asks for history when the contacts sync is refused', async () => {
    await boot({
      requestSmbAppData: async (_id, _t, syncType) => {
        if (syncType === 'smb_app_state_sync') throw new GraphError('Contact sync already requested', 400, 2593002);
        return { requestId: 'req-history' };
      },
    });

    const res = await connect({ code: 'AQD-code', wabaId: '932', phoneNumberId: '136' });

    expect(res.statusCode).toBe(200);
    expect(res.json().syncError).toBe('Contact sync already requested');
    expect(graph.calls.filter((c) => c.method === 'requestSmbAppData')).toHaveLength(2);
    const [row] = await db.select().from(whatsappNumbers);
    expect(row!.syncRequestedAt).toBeNull();
  });

  it('re-connecting the same number renews the token and its deadline', async () => {
    // This is the only cure for a token that is about to expire: Meta issues a new one
    // through the same window, and the button in the cabinet is the same button. A 409
    // here would tell the owner to delete the number, which takes every conversation and
    // every `ctwa_clid` with it — and Meta hands a click identifier over exactly once.
    await boot({
      exchangeCode: async (code) => ({
        token: code === 'two' ? 'EAAB-renewed' : 'EAAB-business-token',
        expiresAt: new Date(code === 'two' ? '2027-01-09T09:00:00.000Z' : '2026-11-10T09:00:00.000Z'),
      }),
    });
    await connect({ code: 'one', wabaId: '932', phoneNumberId: '136' });
    const [before] = await db.select().from(whatsappNumbers);

    const res = await connect({ code: 'two', wabaId: '932', phoneNumberId: '136' });

    expect(res.statusCode).toBe(200);
    const rows = await db.select().from(whatsappNumbers);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(before!.id);
    expect(rows[0]!.tokenExpiresAt).toEqual(new Date('2027-01-09T09:00:00.000Z'));
    expect(
      decryptSecret(asCloudNumber(rows[0]!).accessToken, Buffer.from(env.CREDENTIALS_KEY, 'base64'), '136'),
    ).toBe('EAAB-renewed');
  });

  it('does not ask Meta for the one-shot syncs again when renewing', async () => {
    // Both are once per number on Meta's side; asking again replaces a working number's
    // clean row with «already requested» in red.
    await connect({ code: 'one', wabaId: '932', phoneNumberId: '136' });
    const calls = graph.calls.length;

    await connect({ code: 'two', wabaId: '932', phoneNumberId: '136' });

    expect(graph.calls.slice(calls).map((c) => c.method)).not.toContain('requestSmbAppData');
  });

  it('still refuses a number another agent already connected', async () => {
    await connect({ code: 'one', wabaId: '932', phoneNumberId: '136' });
    const [other] = await db
      .insert(agents)
      .values({ accountId: (await db.select().from(agents))[0]!.accountId, name: 'Второй' })
      .returning();
    await db.update(whatsappNumbers).set({ agentId: other!.id });

    const res = await connect({ code: 'two', wabaId: '932', phoneNumberId: '136' });

    expect(res.statusCode).toBe(409);
    expect(res.json().message).toBe('Этот номер уже подключён к другому агенту');
  });

  it('refuses to take over a number that was connected with a pasted token', async () => {
    // A manual number is somebody's deliberate setup with a system-user token. Quietly
    // turning it into a coexistence number would change how it is renewed for good.
    await connect({ code: 'one', wabaId: '932', phoneNumberId: '136' });
    await db.update(whatsappNumbers).set({ connectionKind: 'manual' });

    const res = await connect({ code: 'two', wabaId: '932', phoneNumberId: '136' });

    expect(res.statusCode).toBe(409);
    expect(res.json().message).toBe('Этот номер уже подключён к этому агенту');
  });

  it('is owner only', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/agents/${agentId}/whatsapp/coexistence`, payload: { code: 'x', wabaId: '932' } });

    expect(res.statusCode).toBe(401);
  });
});
