import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { accountMembers, agents, whatsappNumbers } from '../src/db/schema.js';
import { createAccountWithOwner } from '../src/lib/provision.js';
import { decryptSecret } from '../src/lib/secret-box.js';
import { GraphError } from '../src/lib/whatsapp/graph.js';
import { withDb } from './helpers/db.js';
import { testEnv } from './helpers/env.js';
import { fakeGraph, type FakeGraph } from './helpers/fake-graph.js';
import { asCloudNumber } from '../src/lib/whatsapp/cloud-number.js';

const env = testEnv({ PUBLIC_URL: 'https://rakurs.test' });
const PASSWORD = 'correct-horse-battery';

let app: FastifyInstance;
let db: Awaited<ReturnType<typeof withDb>>;
let graph: FakeGraph;
let agentId: string;
let accountId: string;
let jar: Record<string, string>;

async function login(email: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: PASSWORD },
  });
  const cookie = res.cookies[0]!;
  return { [cookie.name]: cookie.value };
}

beforeEach(async () => {
  db = await withDb();
  graph = fakeGraph();
  app = buildServer(env, db, { graph });
  await app.ready();

  const created = await createAccountWithOwner(db, {
    company: 'Сафина',
    email: 'owner@example.com',
    name: 'Владелец',
    initials: 'ВЛ',
    password: PASSWORD,
  });
  accountId = created.accountId;
  const [agent] = await db.insert(agents).values({ accountId, name: 'Сафина' }).returning();
  agentId = agent!.id;
  jar = await login('owner@example.com');
});

const connect = (payload: Record<string, unknown>, cookies = jar) =>
  app.inject({
    method: 'POST',
    url: `/api/agents/${agentId}/whatsapp/numbers`,
    cookies,
    payload,
  });

const patch = (numberId: string, payload: Record<string, unknown>, cookies = jar) =>
  app.inject({
    method: 'PATCH',
    url: `/api/agents/${agentId}/whatsapp/numbers/${numberId}`,
    cookies,
    payload,
  });

const valid = {
  phoneNumberId: '136',
  wabaId: '932',
  accessToken: 'EAAG-token',
};

describe('connecting a number', () => {
  it('checks the token, subscribes the application and stores the number', async () => {
    const res = await connect(valid);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      phoneNumberId: '136',
      wabaId: '932',
      displayPhone: '+7 708 580 79 32',
      enabled: true,
      subscribed: true,
    });
    expect(res.json().accessToken).toBeUndefined();
    expect(graph.calls.map((c) => c.method)).toEqual(['getPhoneNumber', 'subscribeApp']);
  });

  it('stores the token encrypted', async () => {
    await connect(valid);

    const [stored] = await db.select().from(whatsappNumbers);
    expect(stored!.accessToken).not.toContain('EAAG-token');
    expect(
      decryptSecret(asCloudNumber(stored!).accessToken, Buffer.from(env.CREDENTIALS_KEY, 'base64'), '136'),
    ).toBe('EAAG-token');
  });

  it('refuses a token Meta rejects, and stores nothing', async () => {
    app = buildServer(env, db, {
      graph: fakeGraph({
        getPhoneNumber: async () => {
          throw new GraphError('Invalid OAuth access token.', 401, 190);
        },
      }),
    });
    await app.ready();
    jar = await login('owner@example.com');

    const res = await connect(valid);

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('Meta не приняла эти данные: Invalid OAuth access token.');
    expect(await db.select().from(whatsappNumbers)).toEqual([]);
  });

  it('does not echo the pasted token back when Meta rejects it', async () => {
    app = buildServer(env, db, {
      graph: fakeGraph({
        getPhoneNumber: async () => {
          throw new GraphError(`Malformed access token ${valid.accessToken}`, 401, 190);
        },
      }),
    });
    await app.ready();
    jar = await login('owner@example.com');

    const res = await connect(valid);

    expect(res.statusCode).toBe(400);
    expect(res.json().message).not.toContain(valid.accessToken);
    expect(res.json().message).toContain('<токен скрыт>');
  });

  it('says plainly when the number is stored but Meta will not deliver', async () => {
    app = buildServer(env, db, {
      graph: fakeGraph({
        subscribeApp: async () => {
          throw new GraphError('Application does not have permission', 403, 200);
        },
      }),
    });
    await app.ready();
    jar = await login('owner@example.com');

    const res = await connect(valid);

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('подписать приложение на WABA');
    expect(await db.select().from(whatsappNumbers)).toEqual([]);
  });

  it('refuses a number another agent already uses', async () => {
    const [other] = await db.insert(agents).values({ accountId, name: 'Второй' }).returning();
    await db.insert(whatsappNumbers).values({
      agentId: other!.id,
      phoneNumberId: '136',
      wabaId: '932',
      displayPhone: '+7 708 580 79 32',
      accessToken: 'encrypted',
    });

    const res = await connect(valid);

    expect(res.statusCode).toBe(409);
    expect(res.json().message).toBe('Этот номер уже подключён к другому агенту');
  });

  it('names this agent when the owner re-saves their own number', async () => {
    await connect(valid);

    const res = await connect(valid);

    expect(res.statusCode).toBe(409);
    expect(res.json().message).toBe('Этот номер уже подключён к этому агенту');
  });

  it('rejects a body missing the token', async () => {
    const res = await connect({ phoneNumberId: '136', wabaId: '932' });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('Заполните все три поля');
  });

  it('refuses a member', async () => {
    await db
      .update(accountMembers)
      .set({ role: 'member' })
      .where(eq(accountMembers.accountId, accountId));

    expect((await connect(valid)).statusCode).toBe(403);
  });
});

describe('listing and changing a number', () => {
  it('lists what is connected, without the token', async () => {
    await connect(valid);

    const res = await app.inject({
      method: 'GET',
      url: `/api/agents/${agentId}/whatsapp/numbers`,
      cookies: jar,
    });

    expect(res.json()).toHaveLength(1);
    expect(res.json()[0].accessToken).toBeUndefined();
  });

  it('lets a member read the list', async () => {
    await connect(valid);
    await db
      .update(accountMembers)
      .set({ role: 'member' })
      .where(eq(accountMembers.accountId, accountId));

    const res = await app.inject({
      method: 'GET',
      url: `/api/agents/${agentId}/whatsapp/numbers`,
      cookies: jar,
    });

    expect(res.statusCode).toBe(200);
  });

  it('switches a number off without forgetting it', async () => {
    const { id } = (await connect(valid)).json();

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/agents/${agentId}/whatsapp/numbers/${id}`,
      cookies: jar,
      payload: { enabled: false },
    });

    expect(res.json().enabled).toBe(false);
    expect(await db.select().from(whatsappNumbers)).toHaveLength(1);
  });

  it('replaces the token without touching the conversations behind it', async () => {
    const { id } = (await connect(valid)).json();

    const res = await patch(id, { accessToken: 'EAAG-fresh' });

    expect(res.statusCode).toBe(200);
    // Proved with Meta against this number's own phone_number_id before being stored.
    expect(graph.calls.at(-1)).toMatchObject({
      method: 'getPhoneNumber',
      args: ['136', 'EAAG-fresh'],
    });

    const [stored] = await db.select().from(whatsappNumbers);
    expect(stored!.accessToken).not.toContain('EAAG-fresh');
    expect(
      decryptSecret(asCloudNumber(stored!).accessToken, Buffer.from(env.CREDENTIALS_KEY, 'base64'), '136'),
    ).toBe('EAAG-fresh');
    // The subscription belongs to the WABA, not to the token that requested it.
    expect(stored!.subscribedAt).toBeInstanceOf(Date);
    expect(res.json().subscribed).toBe(true);
    expect(res.json().accessToken).toBeUndefined();
  });

  it('keeps the working token when Meta rejects the new one', async () => {
    const { id } = (await connect(valid)).json();
    app = buildServer(env, db, {
      graph: fakeGraph({
        getPhoneNumber: async () => {
          throw new GraphError('Invalid OAuth access token.', 401, 190);
        },
      }),
    });
    await app.ready();
    jar = await login('owner@example.com');

    const res = await patch(id, { accessToken: 'EAAG-broken' });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('Meta не приняла этот токен: Invalid OAuth access token.');

    const [stored] = await db.select().from(whatsappNumbers);
    expect(
      decryptSecret(asCloudNumber(stored!).accessToken, Buffer.from(env.CREDENTIALS_KEY, 'base64'), '136'),
    ).toBe('EAAG-token');
  });

  it('does not echo the replacement token back when Meta rejects it', async () => {
    const { id } = (await connect(valid)).json();
    app = buildServer(env, db, {
      graph: fakeGraph({
        getPhoneNumber: async () => {
          throw new GraphError('Malformed access token EAAG-broken', 401, 190);
        },
      }),
    });
    await app.ready();
    jar = await login('owner@example.com');

    const res = await patch(id, { accessToken: 'EAAG-broken' });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).not.toContain('EAAG-broken');
    expect(res.json().message).toContain('<токен скрыт>');
  });

  it('refuses a pasted token for a coexistence number', async () => {
    await connect(valid);
    const [row] = await db
      .update(whatsappNumbers)
      .set({ connectionKind: 'coexistence' })
      .where(eq(whatsappNumbers.phoneNumberId, '136'))
      .returning();

    const res = await patch(row!.id, { accessToken: 'EAAG-new' });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('Токен этого номера выдаёт Meta при подключении с телефона, вручную его не заменить');
  });

  it('refuses a body that asks for nothing', async () => {
    const { id } = (await connect(valid)).json();

    const res = await patch(id, {});

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('Не удалось разобрать настройку номера');
  });

  it('does not let a member replace the token', async () => {
    const { id } = (await connect(valid)).json();
    await db
      .update(accountMembers)
      .set({ role: 'member' })
      .where(eq(accountMembers.accountId, accountId));

    expect((await patch(id, { accessToken: 'EAAG-fresh' })).statusCode).toBe(403);
  });

  it('disconnects a number', async () => {
    const { id } = (await connect(valid)).json();

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/agents/${agentId}/whatsapp/numbers/${id}`,
      cookies: jar,
    });

    expect(res.statusCode).toBe(200);
    expect(await db.select().from(whatsappNumbers)).toEqual([]);
  });

  it('hides another agent behind a 404', async () => {
    const stranger = await createAccountWithOwner(db, {
      company: 'Чужая',
      email: 'stranger@example.com',
      name: 'Чужой',
      initials: 'ЧУ',
      password: PASSWORD,
    });
    const [foreign] = await db
      .insert(agents)
      .values({ accountId: stranger.accountId, name: 'Чужой' })
      .returning();

    const res = await app.inject({
      method: 'GET',
      url: `/api/agents/${foreign!.id}/whatsapp/numbers`,
      cookies: jar,
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('what to paste into Meta', () => {
  it('gives the webhook address and the verification string', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/agents/${agentId}/whatsapp/setup`,
      cookies: jar,
    });

    expect(res.json()).toEqual({
      url: 'https://rakurs.test/api/whatsapp/webhook',
      verifyToken: env.META_WEBHOOK_VERIFY_TOKEN,
    });
  });

  it('does not show the verification string to a member', async () => {
    await db
      .update(accountMembers)
      .set({ role: 'member' })
      .where(eq(accountMembers.accountId, accountId));

    const res = await app.inject({
      method: 'GET',
      url: `/api/agents/${agentId}/whatsapp/setup`,
      cookies: jar,
    });

    expect(res.statusCode).toBe(403);
  });
});
