import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import {
  accountMembers,
  agents,
  contacts,
  conversations,
  linkedSessionKeys,
  messages,
  whatsappNumbers,
} from '../src/db/schema.js';
import { createAccountWithOwner } from '../src/lib/provision.js';
import { encryptSecret } from '../src/lib/secret-box.js';
import { linkedAuthState } from '../src/lib/whatsapp/linked/auth-state.js';
import { withDb } from './helpers/db.js';
import { testEnv } from './helpers/env.js';
import { fakeLinked, type FakeLinked } from './helpers/fake-linked.js';

/**
 * Pairing, from the cabinet's side.
 *
 * The QR itself is WhatsApp's business. What these tests are about is the row: it must
 * exist while the code is on screen, fill itself in when the phone answers, and be gone
 * when nobody scans — never left behind as a number that looks connected and is not.
 */

const env = testEnv({ MEDIA_DIR: 'var/media-test' });
const PASSWORD = 'correct-horse-battery';

let app: FastifyInstance;
let db: Awaited<ReturnType<typeof withDb>>;
let linked: FakeLinked;
let agentId: string;
let accountId: string;
let jar: Record<string, string>;

async function login(email = 'owner@example.com') {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: PASSWORD },
  });
  const cookie = res.cookies[0]!;
  return { [cookie.name]: cookie.value };
}

const pair = () =>
  app.inject({
    method: 'POST',
    url: `/api/agents/${agentId}/whatsapp/linked`,
    cookies: jar,
    payload: {},
  });

const numbers = () => db.select().from(whatsappNumbers);

beforeEach(async () => {
  db = await withDb();
  const created = await createAccountWithOwner(db, {
    company: 'Sealhouse',
    email: 'owner@example.com',
    name: 'Владелец',
    initials: 'ВЛ',
    password: PASSWORD,
  });
  accountId = created.accountId;
  const [agent] = await db.insert(agents).values({ accountId, name: 'Sealhouse' }).returning();
  agentId = agent!.id;

  linked = fakeLinked();
  app = buildServer(env, db, { linked, pairingTimeoutMs: 600 });
  await app.ready();
  jar = await login();
});

afterEach(async () => {
  await app.close();
});

describe('starting a pairing', () => {
  it('creates a row in pairing and opens a socket for it', async () => {
    const res = await pair();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ connectionKind: 'linked', linkedState: 'pairing' });
    const [row] = await numbers();
    expect(row!.linkedJid).toBe(`pending:${row!.id}`);
    expect(linked.calls.at(-1)).toMatchObject({ method: 'connect', args: [row!.id] });
  });

  it('refuses a second pairing while one is in flight', async () => {
    await pair();

    const res = await pair();

    expect(res.statusCode).toBe(409);
    expect(res.json().message).toBe('Подключение уже идёт. Закройте его или дождитесь окончания.');
    expect(await numbers()).toHaveLength(1);
  });

  it('leaves no row behind when the socket refuses to start', async () => {
    linked = fakeLinked({
      connect: async () => {
        throw new Error('no network');
      },
    });
    app = buildServer(env, db, { linked, pairingTimeoutMs: 600 });
    await app.ready();
    jar = await login();

    const res = await pair();

    expect(res.statusCode).toBe(502);
    expect(await numbers()).toEqual([]);
  });

  it('refuses a member who is not the owner', async () => {
    const { userId } = await createAccountWithOwner(db, {
      company: 'Другая',
      email: 'member@example.com',
      name: 'Сотрудник',
      initials: 'СО',
      password: PASSWORD,
    });
    await db.insert(accountMembers).values({ accountId, userId, role: 'member' });
    jar = await login('member@example.com');

    const res = await pair();

    expect(res.statusCode).toBe(403);
    expect(await numbers()).toEqual([]);
  });
});

describe('the pairing stream', () => {
  const stream = (numberId: string) =>
    app.inject({
      method: 'GET',
      url: `/api/agents/${agentId}/whatsapp/linked/${numberId}/qr`,
      cookies: jar,
    });

  it('sends every QR the socket issues, then says it opened', async () => {
    await pair();
    const [row] = await numbers();

    const pending = stream(row!.id);
    await new Promise((r) => setTimeout(r, 120));
    linked.report({ type: 'qr', numberId: row!.id, qr: '2@first' });
    linked.report({ type: 'qr', numberId: row!.id, qr: '2@second' });
    linked.report({
      type: 'open',
      numberId: row!.id,
      jid: '77085807932@s.whatsapp.net',
      displayPhone: '+77085807932',
    });
    const res = await pending;

    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.body).toContain('{"type":"qr","qr":"2@first"}');
    expect(res.body).toContain('{"type":"qr","qr":"2@second"}');
    expect(res.body).toContain('{"type":"open"}');
  });

  it('ignores events belonging to another number', async () => {
    await pair();
    const [row] = await numbers();

    const pending = stream(row!.id);
    await new Promise((r) => setTimeout(r, 120));
    linked.report({ type: 'qr', numberId: 'someone-else', qr: '2@not-yours' });
    linked.report({
      type: 'open',
      numberId: row!.id,
      jid: 'x@s.whatsapp.net',
      displayPhone: '+7',
    });
    const res = await pending;

    expect(res.body).not.toContain('not-yours');
  });

  it('gives up after the deadline and removes the row', async () => {
    app = buildServer(env, db, { linked, pairingTimeoutMs: 30 });
    await app.ready();
    jar = await login();
    await pair();
    const [row] = await numbers();

    const res = await stream(row!.id);

    expect(res.body).toContain('"type":"failed"');
    expect(res.body).toContain('Код никто не отсканировал');
    expect(await numbers()).toEqual([]);
  });

  it('says so when the phone refuses the pairing', async () => {
    await pair();
    const [row] = await numbers();

    const pending = stream(row!.id);
    await new Promise((r) => setTimeout(r, 120));
    linked.report({ type: 'closed', numberId: row!.id, loggedOut: true });
    const res = await pending;

    expect(res.body).toContain('Телефон отказал в подключении.');
  });

  it('answers 404 for a number that is not this agent’s', async () => {
    const res = await stream('7ad1e0f4-0000-4000-8000-000000000000');

    expect(res.statusCode).toBe(404);
  });
});

describe('unlinking', () => {
  const unlink = (numberId: string) =>
    app.inject({
      method: 'DELETE',
      url: `/api/agents/${agentId}/whatsapp/linked/${numberId}`,
      cookies: jar,
    });

  it('logs the phone out, forgets the session and keeps the conversations', async () => {
    await pair();
    const [row] = await numbers();
    await (await linkedAuthState(db, Buffer.from(env.CREDENTIALS_KEY, 'base64'), row!.id)).saveCreds();

    const res = await unlink(row!.id);

    expect(res.statusCode).toBe(200);
    expect(linked.calls.some((c) => c.method === 'logout')).toBe(true);
    expect(
      await db
        .select()
        .from(linkedSessionKeys)
        .where(eq(linkedSessionKeys.whatsappNumberId, row!.id)),
    ).toHaveLength(0);
    // The row survives, and with it every thread it carried.
    const [after] = await numbers();
    expect(after).toMatchObject({ linkedState: 'logged_out', enabled: false });
  });

  it('still forgets the session when the phone had already dropped us', async () => {
    await pair();
    const [row] = await numbers();
    linked = fakeLinked({
      logout: async () => {
        throw new Error('socket already gone');
      },
    });
    app = buildServer(env, db, { linked, pairingTimeoutMs: 600 });
    await app.ready();
    jar = await login();

    const res = await unlink(row!.id);

    expect(res.statusCode).toBe(200);
    expect((await numbers())[0]).toMatchObject({ linkedState: 'logged_out' });
  });

  it('refuses to unlink a number connected through Meta', async () => {
    const [meta] = await db
      .insert(whatsappNumbers)
      .values({
        agentId,
        displayPhone: '+7 708 580 79 32',
        connectionKind: 'manual',
        phoneNumberId: '136',
        wabaId: '932',
        accessToken: 'encrypted',
      })
      .returning();

    const res = await unlink(meta!.id);

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('Этот номер подключён не по QR.');
  });
});

describe('sending a file', () => {
  /** A tiny multipart body, written by hand: no helper in the suite builds one. */
  function multipart(fields: { caption?: string }, file: { name: string; type: string; bytes: Buffer }) {
    const boundary = '----rakurstest';
    const head = Buffer.from(
      `--${boundary}\r\n` +
        (fields.caption === undefined
          ? ''
          : `Content-Disposition: form-data; name="caption"\r\n\r\n${fields.caption}\r\n--${boundary}\r\n`) +
        `Content-Disposition: form-data; name="file"; filename="${file.name}"\r\n` +
        `Content-Type: ${file.type}\r\n\r\n`,
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    return {
      payload: Buffer.concat([head, file.bytes, tail]),
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    };
  }

  it('sends an image through the phone and stores it as an operator line', async () => {
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
    linked.setOpen(number!.id, true);
    const [contact] = await db
      .insert(contacts)
      .values({ agentId, phone: '77001234567', name: 'Айгерим' })
      .returning();
    const [conversation] = await db
      .insert(conversations)
      .values({
        agentId,
        contactId: contact!.id,
        whatsappNumberId: number!.id,
        lastInboundAt: new Date(),
      })
      .returning();

    const body = multipart(
      { caption: 'вот макет' },
      { name: 'stamp.png', type: 'image/png', bytes: Buffer.from([1, 2, 3, 4]) },
    );
    const res = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/conversations/${conversation!.id}/files`,
      cookies: jar,
      headers: body.headers,
      payload: body.payload,
    });

    expect(res.statusCode).toBe(200);
    expect(linked.calls.at(-1)?.method).toBe('sendMedia');
    const [stored] = await db.select().from(messages);
    expect(stored).toMatchObject({
      direction: 'out',
      author: 'operator',
      kind: 'image',
      body: 'вот макет',
      mediaMime: 'image/png',
    });
  });

  it('says plainly that a Cloud API number cannot take a file yet', async () => {
    const [number] = await db
      .insert(whatsappNumbers)
      .values({
        agentId,
        displayPhone: '+7 708 580 79 32',
        connectionKind: 'manual',
        phoneNumberId: '136',
        wabaId: '932',
        accessToken: encryptSecret('EAAB', Buffer.from(env.CREDENTIALS_KEY, 'base64'), '136'),
      })
      .returning();
    const [contact] = await db
      .insert(contacts)
      .values({ agentId, phone: '77001234567', name: 'Айгерим' })
      .returning();
    const [conversation] = await db
      .insert(conversations)
      .values({
        agentId,
        contactId: contact!.id,
        whatsappNumberId: number!.id,
        lastInboundAt: new Date(),
      })
      .returning();

    const body = multipart(
      {},
      { name: 'stamp.png', type: 'image/png', bytes: Buffer.from([1, 2, 3, 4]) },
    );
    const res = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/conversations/${conversation!.id}/files`,
      cookies: jar,
      headers: body.headers,
      payload: body.payload,
    });

    expect(res.statusCode).toBe(501);
    expect(res.json().message).toBe(
      'Отправка файлов пока работает только для номера, подключённого по QR.',
    );
    expect(await db.select().from(messages)).toEqual([]);
  });
});
