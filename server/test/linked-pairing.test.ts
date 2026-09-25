import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { clearStalePairings } from '../src/lib/whatsapp/linked/lifecycle.js';
import { withDb } from './helpers/db.js';
import { testEnv } from './helpers/env.js';
import { fakeGraph } from './helpers/fake-graph.js';
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

async function existingPhone() {
  const [number] = await db.insert(whatsappNumbers).values({ agentId, connectionKind: 'linked',
    displayPhone: '+77011234567', linkedJid: '77011234567@s.whatsapp.net', linkedState: 'logged_out',
    createdAt: new Date('2020-01-01'), enabled: false }).returning();
  const [contact] = await db.insert(contacts).values({ agentId, phone: '77017654321' }).returning();
  const [conversation] = await db.insert(conversations).values({ agentId, contactId: contact!.id,
    whatsappNumberId: number!.id }).returning();
  await db.insert(messages).values({ conversationId: conversation!.id, direction: 'in', author: 'client',
    kind: 'text', body: 'Preserve this message', sentAt: new Date() });
  return number!;
}

describe('reconnecting an existing phone', () => {
  it('reuses its row and preserves history after the pairing deadline', async () => {
    const number = await existingPhone();
    const response = await app.inject({ method: 'POST', url: `/api/agents/${agentId}/whatsapp/linked/${number.id}/reconnect`, cookies: jar });
    expect(response.statusCode).toBe(200);
    expect(response.json().id).toBe(number.id);
    expect((await numbers())[0]?.linkedState).toBe('pairing');
    await new Promise(resolve => setTimeout(resolve, 750));
    expect((await numbers())[0]).toMatchObject({ id: number.id, linkedState: 'logged_out', enabled: false });
    expect(await db.select().from(messages)).toHaveLength(1);
  });

  it('preserves an interrupted reconnect during startup cleanup', async () => {
    const number = await existingPhone();
    await db.update(whatsappNumbers).set({ linkedState: 'pairing' }).where(eq(whatsappNumbers.id, number.id));
    await clearStalePairings(db);
    expect((await numbers())[0]).toMatchObject({ id: number.id, linkedState: 'logged_out' });
    expect(await db.select().from(messages)).toHaveLength(1);
  });
});

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

  it('removes the row when the deadline passes and nobody ever watched the stream', async () => {
    app = buildServer(env, db, { linked, pairingTimeoutMs: 30 });
    await app.ready();
    jar = await login();

    await pair();
    await new Promise((r) => setTimeout(r, 150));

    expect(await numbers()).toEqual([]);
    expect(linked.calls.some((c) => c.method === 'disconnect')).toBe(true);
  });

  it('lets the next pairing start once an abandoned one has expired', async () => {
    app = buildServer(env, db, { linked, pairingTimeoutMs: 30 });
    await app.ready();
    jar = await login();
    await pair();
    await new Promise((r) => setTimeout(r, 150));

    const res = await pair();

    expect(res.statusCode).toBe(200);
    expect(await numbers()).toHaveLength(1);
  });

  it('keeps the row once the phone has answered, deadline or not', async () => {
    app = buildServer(env, db, { linked, pairingTimeoutMs: 30 });
    await app.ready();
    jar = await login();
    await pair();
    const [row] = await numbers();

    linked.report({
      type: 'open',
      numberId: row!.id,
      jid: '77085807932@s.whatsapp.net',
      displayPhone: '+77085807932',
    });
    await new Promise((r) => setTimeout(r, 150));

    expect(await numbers()).toHaveLength(1);
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

  it('keeps waiting through the close that a scan itself causes', async () => {
    await pair();
    const [row] = await numbers();

    const pending = stream(row!.id);
    await new Promise((r) => setTimeout(r, 120));
    linked.report({ type: 'qr', numberId: row!.id, qr: '2@scanned' });
    // WhatsApp answers a successful scan by closing the socket and asking for a restart,
    // and it closes the same way when it runs out of codes. Both are the lifecycle's to
    // reconnect: ending the stream here is what made a scanned code produce nothing.
    linked.report({ type: 'closed', numberId: row!.id, loggedOut: false });
    linked.report({ type: 'qr', numberId: row!.id, qr: '2@after-restart' });
    linked.report({
      type: 'open',
      numberId: row!.id,
      jid: '77085807932@s.whatsapp.net',
      displayPhone: '+77085807932',
    });
    const res = await pending;

    expect(res.body).not.toContain('"type":"failed"');
    expect(res.body).toContain('2@after-restart');
    expect(res.body).toContain('{"type":"open"}');
    expect(await numbers()).toHaveLength(1);
  });

  it('answers 404 for a number that is not this agent’s', async () => {
    const res = await stream('7ad1e0f4-0000-4000-8000-000000000000');

    expect(res.statusCode).toBe(404);
  });
});

describe('a pairing left behind by a dead process', () => {
  it('is cleared on start, so the next attempt is not refused', async () => {
    const id = randomUUID();
    await db.insert(whatsappNumbers).values({
      id,
      agentId,
      displayPhone: '',
      connectionKind: 'linked',
      linkedJid: `pending:${id}`,
      linkedState: 'pairing',
    });

    const removed = await clearStalePairings(db);

    expect(removed).toBe(1);
    expect(await numbers()).toEqual([]);
  });

  it('leaves a number that is actually connected alone', async () => {
    const id = randomUUID();
    await db.insert(whatsappNumbers).values({
      id,
      agentId,
      displayPhone: '+77085807932',
      connectionKind: 'linked',
      linkedJid: '77085807932@s.whatsapp.net',
      linkedState: 'open',
    });

    await clearStalePairings(db);

    expect(await numbers()).toHaveLength(1);
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

  it.each([true, false])('sends Cloud media only inside the reply window (open=%s)', async (open) => {
    const sendMedia = vi.fn(async () => ({ messageId: 'wamid.cloud-media' }));
    await app.close();
    app = buildServer(env, db, { linked, graph: { ...fakeGraph(), sendMedia }, pairingTimeoutMs: 600 });
    await app.ready();
    const [number] = await db
      .insert(whatsappNumbers)
      .values({
        agentId,
        displayPhone: '+7 708 580 79 32',
        connectionKind: 'manual',
        enabled: true,
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
        lastInboundAt: new Date(Date.now() - (open ? 0 : 25 * 60 * 60 * 1000)),
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

    if (!open) {
      expect(res.statusCode).toBe(409);
      expect(res.json().message).toContain('Окно ответа закрыто');
      expect(sendMedia).not.toHaveBeenCalled();
      expect(await db.select().from(messages)).toEqual([]);
      return;
    }
    expect(res.statusCode).toBe(200);
    expect(sendMedia).toHaveBeenCalledWith('136', 'EAAB', '77001234567', expect.objectContaining({
      path: expect.any(String), mime: 'image/png', filename: 'stamp.png',
    }));
    expect(res.json()).toMatchObject({ kind: 'image', author: 'operator', mediaMime: 'image/png' });
    expect(await db.select().from(messages)).toEqual([expect.objectContaining({
      waMessageId: 'wamid.cloud-media', kind: 'image', mediaMime: 'image/png', direction: 'out',
    })]);
  });
});

describe('the QR pairing switch', () => {
  const availability = () =>
    app.inject({ method: 'GET', url: `/api/agents/${agentId}/whatsapp/qr-pairing`, cookies: jar });

  async function switchedOff() {
    await app.close();
    app = buildServer(testEnv({ MEDIA_DIR: 'var/media-test', WHATSAPP_QR_ENABLED: 'false' }), db,
      { linked, pairingTimeoutMs: 600 });
    await app.ready();
    jar = await login();
  }

  it('is on for every account unless the server turns it off', async () => {
    expect((await availability()).json()).toEqual({ enabled: true });
    await switchedOff();
    expect((await availability()).json()).toEqual({ enabled: false });
  });

  it('refuses a new pairing when off, without creating a row or a socket', async () => {
    await switchedOff();

    const res = await pair();

    expect(res.statusCode).toBe(403);
    expect(await numbers()).toEqual([]);
    expect(linked.calls.some((c) => c.method === 'connect')).toBe(false);
  });

  it('still lets an already paired phone reconnect when off', async () => {
    const number = await existingPhone();
    await switchedOff();

    const res = await app.inject({ method: 'POST',
      url: `/api/agents/${agentId}/whatsapp/linked/${number.id}/reconnect`, cookies: jar });

    expect(res.statusCode).toBe(200);
  });
});
