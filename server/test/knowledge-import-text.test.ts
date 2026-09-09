import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { kbNotes, kbSources } from '../src/db/schema.js';
import { addMember, createAccountWithOwner } from '../src/lib/provision.js';
import { withDb } from './helpers/db.js';
import { testEnv } from './helpers/env.js';
import { fakeGraph } from './helpers/fake-graph.js';

const env = testEnv();
const PASSWORD = 'correct-horse-battery';

let app: FastifyInstance;
let db: Awaited<ReturnType<typeof withDb>>;
let accountId: string;
let agentId: string;
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

beforeEach(async () => {
  db = await withDb();
  ({ accountId } = await createAccountWithOwner(db, {
    company: 'Сафина',
    email: 'owner@example.com',
    name: 'Владелец',
    initials: 'ВЛ',
    password: PASSWORD,
  }));
  await addMember(db, {
    company: 'Сафина',
    email: 'member@example.com',
    name: 'Оператор',
    initials: 'ОП',
    password: PASSWORD,
    role: 'member',
  });

  app = buildServer(env, db, { graph: fakeGraph() });
  await app.ready();
  jar = await login();

  const created = await app.inject({
    method: 'POST',
    url: `/api/accounts/${accountId}/agents`,
    cookies: jar,
    payload: { name: 'Сафина' },
  });
  agentId = created.json().id;
});

afterEach(async () => {
  await app.close();
});

const notes = () => `/api/agents/${agentId}/knowledge/notes`;
const search = () => `/api/agents/${agentId}/knowledge/search`;

const importText = (payload: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: `/api/agents/${agentId}/knowledge/import/text`,
    cookies: jar,
    payload,
  });

/** A paste, under the one title these tests don't otherwise care about. */
const paste = (text: string, extra: Record<string, unknown> = {}) =>
  importText({ title: 'Прайс-лист', text, ...extra });

describe('importing pasted text', () => {
  it('makes a note per block under the paste folder', async () => {
    const res = await paste('Двери\nМеталл.\n\nДоставка\n1500 ₸.');

    expect(res.statusCode).toBe(200);
    expect(res.json().notes.map((n: { path: string }) => n.path)).toEqual([
      'Вставки/Двери',
      'Вставки/Доставка',
    ]);
  });

  it('numbers a second paste of the same title rather than refusing it', async () => {
    await paste('Двери\nМеталл.');
    const res = await paste('Двери\nДерево.');

    expect(res.statusCode).toBe(200);
    expect(res.json().notes[0]!.path).toBe('Вставки/Двери (2)');
  });

  it('creates a source and answers with it and its notes', async () => {
    const res = await paste('Дверь входная\nОт 90 000 тенге.\n\nОкно\nОт 40 000 тенге.', {
      kind: 'product',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().source.status).toBe('ready');
    expect(res.json().source.itemCount).toBe(2);
    expect(res.json().notes).toHaveLength(2);
    expect(res.json().notes[0].kind).toBe('product');
    expect(res.json().notes[0].sourceTitle).toBe('Прайс-лист');
    expect(res.json().reimported).toBe(false);
    expect(res.json().keptEdited).toBe(0);
  });

  it('defaults the kind to other', async () => {
    const res = await paste('Работаем с 9 до 18.');

    expect(res.json().notes[0].kind).toBe('other');
  });

  it('refuses text that holds nothing', async () => {
    const res = await paste('   \n\n  ');

    expect(res.statusCode).toBe(400);
    expect(await db.select().from(kbSources)).toHaveLength(0);
    expect(await db.select().from(kbNotes)).toHaveLength(0);
  });

  it('refuses a paste larger than we will store', async () => {
    const res = await paste('а'.repeat(200_001));

    expect(res.statusCode).toBe(400);
    expect(await db.select().from(kbSources)).toHaveLength(0);
  });

  it('is refused for a member', async () => {
    const memberJar = await login('member@example.com');

    const res = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/knowledge/import/text`,
      cookies: memberJar,
      payload: { title: 'Прайс', text: 'Двери\nЦена.' },
    });

    expect(res.statusCode).toBe(403);
  });

  it('writes no source when a note cannot be written', async () => {
    // The failure has to come from the note insert itself, so it is induced rather than
    // found. What the trigger raises does not matter — what matters is that the source row,
    // which is written first, is not left behind claiming a note that does not exist.
    await db.execute(sql`
      create function kb_notes_refuse() returns trigger language plpgsql as $$
      begin raise exception 'induced failure'; end $$
    `);
    await db.execute(sql`
      create trigger kb_notes_refuse before insert on kb_notes
      for each row execute function kb_notes_refuse()
    `);

    try {
      const res = await paste('Дверь\nЦена 90 000.');

      expect(res.statusCode).toBe(500);
      expect(await db.select().from(kbSources)).toHaveLength(0);
      expect(await db.select({ id: kbNotes.id }).from(kbNotes)).toHaveLength(0);
    } finally {
      await db.execute(sql`drop trigger kb_notes_refuse on kb_notes`);
      await db.execute(sql`drop function kb_notes_refuse()`);
    }
  });

  it('imports a paste carrying the control characters a PDF leaves behind', async () => {
    const res = await paste('Дверь\u0000 входная\nОт 90 000\u0001 тенге.');

    expect(res.statusCode).toBe(200);
    expect(res.json().notes[0].path).toBe('Вставки/Дверь входная');

    const opened = await app.inject({
      method: 'GET',
      url: `${notes()}/${res.json().notes[0].id}`,
      cookies: jar,
    });
    expect(opened.json().body).toBe('От 90 000 тенге.');
  });

  it('refuses a paste that is nothing but control characters', async () => {
    const res = await paste('\u0000\u0001\u0000');

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('В тексте нечего сохранить');
    expect(await db.select().from(kbSources)).toHaveLength(0);
    expect(await db.select({ id: kbNotes.id }).from(kbNotes)).toHaveLength(0);
  });

  it('makes the imported notes searchable', async () => {
    await paste('Дверь входная\nМеталлическая, Алматы.');

    const found = await app.inject({ url: `${search()}?q=металлическая`, cookies: jar });

    expect(found.json()).toHaveLength(1);
  });

  /**
   * A regression guard for the shape, not the number: `saveNoteAtUniquePath` used to write
   * every note inside its own `SAVEPOINT`, so a bulk import paid one subtransaction per note.
   * Postgres caches only about 64 subtransaction ids per backend, and past that the cost of
   * every later visibility check in the same transaction goes up — a 1 500-block paste (this
   * size, 38 655 characters) measured at 16.1s under that shape on this test database, and a
   * 5 400-block paste (198 688 characters, near the 200 000-character limit
   * `docs/knowledge-base.md` advertises) at 233.7s, well past `deploy/nginx.conf`'s 120s
   * `proxy_read_timeout` — a paste at the documented limit reliably timed out.
   *
   * Writing straight to the transaction (see `saveNoteAtUniquePath`'s comment) measured 8.3s
   * for this same size, and grows linearly rather than the old shape's super-linear blowup —
   * 3 000 blocks went from 55.9s to 17.8s. 1 500 is large enough to be well past the 64-note
   * cliff and small enough that this test costs single-digit seconds rather than the tens a
   * size nearer the real limit would; 12s is comfortably above the measured 8.3s and
   * comfortably under the old shape's 16.1s at the same size, so a regression here fails this
   * test long before a customer would see a 504.
   */
  it('completes a bulk paste past the old savepoint-per-note cliff well inside a timeout', async () => {
    const blocks = Array.from({ length: 1500 }, (_, i) => `Позиция ${i}\nЦена ${i} ₸.`);

    const startedAt = Date.now();
    const res = await paste(blocks.join('\n\n'));
    const elapsedMs = Date.now() - startedAt;

    expect(res.statusCode).toBe(200);
    expect(res.json().notes).toHaveLength(1500);
    expect(elapsedMs).toBeLessThan(12_000);
  }, 30_000);
});
