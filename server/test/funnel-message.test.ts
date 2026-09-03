import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import {
  contacts,
  conversations,
  messages,
  notes,
  stages,
  whatsappNumbers,
} from '../src/db/schema.js';
import { createAccountWithOwner } from '../src/lib/provision.js';
import { encryptSecret } from '../src/lib/secret-box.js';
import { renderTemplate, sendStageMessage } from '../src/lib/funnel-message.js';
import { GraphError } from '../src/lib/whatsapp/graph.js';
import { withDb } from './helpers/db.js';
import { testEnv } from './helpers/env.js';
import { fakeGraph, type FakeGraph } from './helpers/fake-graph.js';

const env = testEnv();
const key = Buffer.from(env.CREDENTIALS_KEY, 'base64');
const PASSWORD = 'correct-horse-battery';
const DAY = 24 * 60 * 60 * 1000;

let app: FastifyInstance;
let db: Awaited<ReturnType<typeof withDb>>;
let graph: FakeGraph;
let accountId: string;
let agentId: string;
let numberId: string;
let conversationId: string;
let jar: Record<string, string>;

async function login() {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'owner@example.com', password: PASSWORD },
  });
  const cookie = res.cookies[0]!;
  return { [cookie.name]: cookie.value };
}

/** Rebuilds the server on a different Graph client and signs back in. */
async function withGraph(next: FakeGraph) {
  await app.close();
  graph = next;
  app = buildServer(env, db, { graph });
  await app.ready();
  jar = await login();
}

async function stageNamed(name: string) {
  const rows = await db.select().from(stages).where(eq(stages.agentId, agentId));
  return rows.find((row) => row.name === name)!;
}

/** Gives a stage a template and returns its id. */
async function template(name: string, text: string) {
  const stage = await stageNamed(name);
  await app.inject({
    method: 'PATCH',
    url: `/api/agents/${agentId}/stages/${stage.id}`,
    cookies: jar,
    payload: { autoMessage: text },
  });
  return stage.id;
}

const move = (stageId: string | null) =>
  app.inject({
    method: 'PATCH',
    url: `/api/agents/${agentId}/conversations/${conversationId}/lead`,
    cookies: jar,
    payload: { stageId },
  });

beforeEach(async () => {
  db = await withDb();
  ({ accountId } = await createAccountWithOwner(db, {
    company: 'Сафина',
    email: 'owner@example.com',
    name: 'Владелец',
    initials: 'ВЛ',
    password: PASSWORD,
  }));

  graph = fakeGraph();
  app = buildServer(env, db, { graph });
  await app.ready();
  jar = await login();

  const created = await app.inject({
    method: 'POST',
    url: `/api/accounts/${accountId}/agents`,
    cookies: jar,
    payload: { name: 'Сафина' },
  });
  agentId = created.json().id;

  const [number] = await db
    .insert(whatsappNumbers)
    .values({
      agentId,
      phoneNumberId: '136',
      wabaId: 'waba',
      displayPhone: '+7 708 580 79 32',
      accessToken: encryptSecret('EAAG-token', key, '136'),
    })
    .returning();
  numberId = number!.id;

  const [contact] = await db
    .insert(contacts)
    .values({ agentId, phone: '77085807932', name: 'Айгуль' })
    .returning();
  const [conversation] = await db
    .insert(conversations)
    .values({
      agentId,
      contactId: contact!.id,
      whatsappNumberId: numberId,
      // Inside the window: the customer wrote a minute ago.
      lastInboundAt: new Date(Date.now() - 60_000),
      lastMessageAt: new Date(Date.now() - 60_000),
    })
    .returning();
  conversationId = conversation!.id;
});

afterEach(async () => {
  await app.close();
});

describe('renderTemplate', () => {
  it('puts the name in', () => {
    expect(renderTemplate('Здравствуйте, {{name}}!', 'Айгуль')).toBe('Здравствуйте, Айгуль!');
  });

  it('leaves nothing behind when there is no name', () => {
    // Not a placeholder: the customer would read whatever we put here.
    expect(renderTemplate('Здравствуйте, {{name}}!', null)).toBe('Здравствуйте, !');
  });

  it('replaces every occurrence', () => {
    expect(renderTemplate('{{name}}, {{name}}', 'Аян')).toBe('Аян, Аян');
  });

  it('leaves an unknown placeholder alone', () => {
    expect(renderTemplate('Ваш {{product}}', 'Аян')).toBe('Ваш {{product}}');
  });
});

describe('the stage auto-message', () => {
  it('is not sent when the lead is given its first stage', async () => {
    const stageId = await template('В диалоге', 'Здравствуйте, {{name}}!');

    await move(stageId);

    expect(graph.calls.filter((call) => call.method === 'sendText')).toHaveLength(0);
    const stored = await db.select().from(messages).where(eq(messages.conversationId, conversationId));
    expect(stored).toHaveLength(0);
  });

  it('is sent on a later move and stored as a message', async () => {
    const first = await stageNamed('Новый лид');
    const stageId = await template('В диалоге', 'Здравствуйте, {{name}}! Мы на связи.');
    await move(first.id);

    const res = await move(stageId);

    expect(res.statusCode).toBe(200);
    const sent = graph.calls.filter((call) => call.method === 'sendText');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.args[3]).toBe('Здравствуйте, Айгуль! Мы на связи.');

    const stored = await db.select().from(messages).where(eq(messages.conversationId, conversationId));
    expect(stored).toHaveLength(1);
    expect(stored[0]?.direction).toBe('out');
    expect(stored[0]?.author).toBe('system');
    expect(stored[0]?.status).toBe('sent');
  });

  it('does not go out when the move loses the race it did not see', async () => {
    const first = await stageNamed('Новый лид');
    const stageId = await template('В диалоге', 'Здравствуйте, {{name}}!');
    await move(first.id);

    // The race, made deterministic. A second writer holds the conversation row, so the
    // request reads the old stage and then blocks on its own UPDATE; the row is moved out
    // from under it and released. Under READ COMMITTED the UPDATE re-checks its WHERE
    // against the new row — the stage it read is no longer there, it matches nothing, and
    // this request must stay quiet. Without that guard the customer reads the template
    // twice: once from the writer that won and once from this one.
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const other = db.transaction(async (tx) => {
      await tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .for('update');
      await held;
      await tx
        .update(conversations)
        .set({ stageId })
        .where(eq(conversations.id, conversationId));
    });

    const blocked = move(stageId);
    // Long enough for the request to read and reach its blocked UPDATE.
    await new Promise((resolve) => setTimeout(resolve, 300));
    release!();
    await other;
    const res = await blocked;

    expect(res.statusCode).toBe(200);
    expect(graph.calls.filter((call) => call.method === 'sendText')).toHaveLength(0);
    const stored = await db.select().from(messages).where(eq(messages.conversationId, conversationId));
    expect(stored).toHaveLength(0);
  });

  it('sends nothing for a stage with no template', async () => {
    const first = await stageNamed('Новый лид');
    const second = await stageNamed('В диалоге');
    await move(first.id);

    await move(second.id);

    expect(graph.calls.filter((call) => call.method === 'sendText')).toHaveLength(0);
  });

  it('writes a note instead of sending when the window is closed', async () => {
    const first = await stageNamed('Новый лид');
    const stageId = await template('В диалоге', 'Здравствуйте!');
    await move(first.id);
    await db
      .update(conversations)
      .set({ lastInboundAt: new Date(Date.now() - DAY - 60_000) })
      .where(eq(conversations.id, conversationId));

    const res = await move(stageId);

    expect(graph.calls.filter((call) => call.method === 'sendText')).toHaveLength(0);
    expect(res.json().stageId).toBe(stageId);
    expect(res.json().notes).toHaveLength(1);
    expect(res.json().notes[0].body).toContain('окно');
    expect(res.json().notes[0].authorName).toBeNull();
  });

  it('writes a note instead of sending when the number is off', async () => {
    const first = await stageNamed('Новый лид');
    const stageId = await template('В диалоге', 'Здравствуйте!');
    await move(first.id);
    await db.update(whatsappNumbers).set({ enabled: false }).where(eq(whatsappNumbers.id, numberId));

    const res = await move(stageId);

    expect(graph.calls.filter((call) => call.method === 'sendText')).toHaveLength(0);
    expect(res.json().notes[0].body).toContain('номер');
  });

  it('keeps the move when Meta refuses the message', async () => {
    const first = await stageNamed('Новый лид');
    const stageId = await template('В диалоге', 'Здравствуйте!');
    await move(first.id);
    await withGraph(
      fakeGraph({
        sendText: async () => {
          throw new GraphError('Malformed access token EAAG-token', 401, 190);
        },
      }),
    );

    const res = await move(stageId);

    expect(res.statusCode).toBe(200);
    expect(res.json().stageId).toBe(stageId);
    expect(res.json().notes).toHaveLength(1);
    // The token Meta echoed back must not be written into the note.
    expect(res.json().notes[0].body).not.toContain('EAAG-token');
    expect(res.json().notes[0].body).toContain('<токен скрыт>');
  });

  it('says the message went out when Meta accepted it but storing it failed', async () => {
    const first = await stageNamed('Новый лид');
    const stageId = await template('В диалоге', 'Здравствуйте!');
    await move(first.id);
    // Meta hands back an id the thread already holds, so the insert after the accepted
    // send is the thing that fails. The customer has the message either way.
    await db.insert(messages).values({
      conversationId,
      waMessageId: 'wamid.taken',
      direction: 'in',
      author: 'client',
      kind: 'text',
      body: 'Здравствуйте',
      sentAt: new Date(),
    });
    await withGraph(fakeGraph({ sendText: async () => ({ messageId: 'wamid.taken' }) }));

    const res = await move(stageId);

    expect(res.statusCode).toBe(200);
    expect(res.json().stageId).toBe(stageId);
    // The operator must not read this as "resend it".
    expect(res.json().notes[0].body).toContain('отправлено, но не сохранено');
  });

  it('moves the conversation forward in the list when it sends', async () => {
    const first = await stageNamed('Новый лид');
    const stageId = await template('В диалоге', 'Здравствуйте!');
    await move(first.id);
    const before = await db.select().from(conversations).where(eq(conversations.id, conversationId));

    await move(stageId);

    const after = await db.select().from(conversations).where(eq(conversations.id, conversationId));
    expect(after[0]!.lastMessageAt!.getTime()).toBeGreaterThan(
      before[0]!.lastMessageAt!.getTime(),
    );
  });

  it('says the outcome is unknown when Meta did not answer in time', async () => {
    const first = await stageNamed('Новый лид');
    const stageId = await template('В диалоге', 'Здравствуйте!');
    await move(first.id);
    await withGraph(
      fakeGraph({
        sendText: async () => {
          throw new GraphError('Meta не ответила за 15 с.', 504);
        },
      }),
    );

    const res = await move(stageId);

    expect(res.statusCode).toBe(200);
    expect(res.json().stageId).toBe(stageId);
    // Meta may have accepted it and simply not said so in time. An operator told it failed
    // sends the customer a second copy of the same greeting.
    const body = res.json().notes[0].body as string;
    expect(body).not.toContain('не отправлено');
    expect(body).toContain('Посмотрите переписку');
  });

  it('does nothing for a stage belonging to another agent', async () => {
    const stageId = await template('В диалоге', 'Здравствуйте!');

    // Called directly, not through the route: the PATCH proves the stage belongs to the
    // agent before it ever gets here, so nothing else in this suite reaches the scoping
    // inside the sender itself.
    await sendStageMessage(db, { graph, key }, { agentId: randomUUID(), conversationId, stageId });

    expect(graph.calls.filter((call) => call.method === 'sendText')).toHaveLength(0);
    // Not even a note: a stage this agent does not own is not a refusal to explain to
    // anyone, it is a call that should never have been made.
    const written = await db.select().from(notes).where(eq(notes.conversationId, conversationId));
    expect(written).toHaveLength(0);
  });

  it('keeps the move when the credentials key no longer matches', async () => {
    const first = await stageNamed('Новый лид');
    const stageId = await template('В диалоге', 'Здравствуйте!');
    await move(first.id);
    // A rotated key, or a row restored from a dump taken under another one. The token
    // cannot be decrypted, so the message cannot go — and the move still has to stand.
    await app.close();
    app = buildServer(testEnv({ CREDENTIALS_KEY: Buffer.alloc(32, 9).toString('base64') }), db, {
      graph,
    });
    await app.ready();
    jar = await login();

    const res = await move(stageId);

    expect(res.statusCode).toBe(200);
    expect(res.json().stageId).toBe(stageId);
    expect(graph.calls.filter((call) => call.method === 'sendText')).toHaveLength(0);
    expect(res.json().notes).toHaveLength(1);
    // The note is read by an operator, so it says what to do rather than repeating the
    // crypto library's English complaint about a malformed secret.
    const body = res.json().notes[0].body as string;
    expect(body).toContain('не удалось прочитать токен номера');
    expect(body).toContain('Подключите номер заново');
    expect(body).not.toMatch(/[A-Za-z]{4}/);
  });

  it('sends nothing when the lead is taken out of its stage', async () => {
    const stageId = await template('Новый лид', 'Здравствуйте!');
    await move(stageId);

    const res = await move(null);

    expect(res.statusCode).toBe(200);
    expect(res.json().stageId).toBeNull();
    expect(graph.calls.filter((call) => call.method === 'sendText')).toHaveLength(0);
  });

  it('sends nothing when the patch only changes the assignee', async () => {
    const stageId = await template('Новый лид', 'Здравствуйте!');
    await move(stageId);
    const members = await app.inject({
      method: 'GET',
      url: `/api/agents/${agentId}/members`,
      cookies: jar,
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/agents/${agentId}/conversations/${conversationId}/lead`,
      cookies: jar,
      payload: { assignedTo: members.json()[0].id },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().assignedTo).toBe(members.json()[0].id);
    expect(graph.calls.filter((call) => call.method === 'sendText')).toHaveLength(0);
  });
});
