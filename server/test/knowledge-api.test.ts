import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { kbChunks, kbNotes } from '../src/db/schema.js';
import { saveNote } from '../src/lib/knowledge/notes.js';
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

const notes = () => `/api/agents/${agentId}/knowledge/notes`;
const search = () => `/api/agents/${agentId}/knowledge/search`;
const graph = () => `/api/agents/${agentId}/knowledge/graph`;
// Named for what the routes underneath it are, not for the segment: `${sources()}/text` is
// `.../knowledge/import/text`, the same base the sandbox test hits for its 403.
const sources = () => `/api/agents/${agentId}/knowledge/import`;

async function add(payload: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: notes(), cookies: jar, payload });
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

describe('notes', () => {
  it('creates a note and answers it with its sections', async () => {
    const res = await app.inject({
      method: 'POST',
      url: notes(),
      cookies: jar,
      payload: { path: 'Товары/Двери', body: '## Цена\n80 000 ₸.' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().sections.map((s: { title: string }) => s.title)).toEqual(['Двери › Цена']);
  });

  it('refuses a second note at the same path in the operator language', async () => {
    await app.inject({ method: 'POST', url: notes(), cookies: jar, payload: { path: 'Двери', body: 'Раз.' } });
    const res = await app.inject({
      method: 'POST',
      url: notes(),
      cookies: jar,
      payload: { path: 'Двери', body: 'Два.' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toBe('Заметка с таким названием уже есть');
  });

  it('refuses a path that is empty, absolute or too deep', async () => {
    for (const path of ['', '/Двери', 'а/б/в/г/д/е/ж/з/и/к/л']) {
      const res = await app.inject({ method: 'POST', url: notes(), cookies: jar, payload: { path, body: 'Раз.' } });
      expect(res.statusCode).toBe(400);
    }
  });

  it('searches sections and names the note each belongs to', async () => {
    await add({ path: 'Доставка', body: '## По городу\n1500 ₸.\n\n## Возврат\n14 дней.' });

    const res = await app.inject({ method: 'GET', url: `${search()}?q=возврат`, cookies: jar });

    expect(res.json().map((s: { title: string }) => s.title)).toEqual(['Доставка › Возврат']);
    expect(res.json()[0]!.noteId).toBeTruthy();
  });

  it('lists the newest notes first, capped at the list limit', async () => {
    await add({ path: 'Старая', body: 'Раз.' });
    await add({ path: 'Новая', body: 'Два.' });

    const res = await app.inject({ method: 'GET', url: notes(), cookies: jar });

    expect(res.json()[0]!.path).toBe('Новая');
    expect(res.json().length).toBeLessThanOrEqual(100);
  });

  // A bulk import writes every note it produces in one pass, and `saveNote`'s `updatedAt` is
  // Postgres's own `now()` — the same instant for every row of one paste. Without a second
  // column to break the tie, which of those notes lands first (and so which hundred survives
  // `LIST_LIMIT`) is whatever order Postgres happens to return equal timestamps in, not a
  // promise it makes — this pins the order to `id` instead, forced here with an explicit
  // shared timestamp rather than a race that may or may not land on the same instant.
  it('breaks a tied updatedAt by id, so a bulk import lists deterministically', async () => {
    const tied = new Date();
    const rows = await db
      .insert(kbNotes)
      .values(
        Array.from({ length: 5 }, (_, i) => ({
          agentId,
          path: `Пачка/${i}`,
          title: `${i}`,
          updatedAt: tied,
        })),
      )
      .returning({ id: kbNotes.id });

    const res = await app.inject({ method: 'GET', url: notes(), cookies: jar });

    const byIdDesc = [...rows].sort((a, b) => (a.id < b.id ? 1 : -1)).map((r) => r.id);
    expect(res.json().map((n: { id: string }) => n.id)).toEqual(byIdDesc);
  });

  it('narrows the search branch of the list to a kind inside the query, not after the limit', async () => {
    // Twenty notes that outrank the one we actually want on the word alone, none of them a
    // product. If `kind` trimmed the answer after `searchKnowledge` had already cut to
    // `SEARCH_LIMIT`, these twenty would fill the cap by themselves and the product note
    // would never make it into the response to be filtered out of.
    for (let i = 0; i < 20; i++) {
      await saveNote(db, { agentId, path: `Прочее/${i}`, body: `Доставка доставка доставка ${i}.` });
    }
    await saveNote(db, {
      agentId,
      path: 'Дверь входная',
      body: '---\nkind: product\n---\nЦена включает доставку.',
    });

    const res = await app.inject({ method: 'GET', url: `${notes()}?q=доставка&kind=product`, cookies: jar });

    expect(res.json().map((n: { path: string }) => n.path)).toEqual(['Дверь входная']);
  });

  it('narrows the browse branch of the list to a kind inside the query, not after the limit', async () => {
    const target = (await add({ path: 'Дверь входная', body: '---\nkind: product\n---\nЦена.' })).json();

    // A hundred notes strictly newer than the target, none of them a product: browsing
    // without `kind` would already have pushed the target out of the newest hundred, so if
    // `kind` were applied to that already-capped list instead of inside the `WHERE`, the
    // target could not possibly come back.
    await db.insert(kbNotes).values(
      Array.from({ length: 100 }, (_, i) => ({
        agentId,
        path: `Прочее/${i}`,
        title: `${i}`,
        kind: 'other',
      })),
    );

    const res = await app.inject({ method: 'GET', url: `${notes()}?kind=product`, cookies: jar });

    expect(res.json().map((n: { path: string }) => n.path)).toEqual([target.path]);
  });

  it('answers backlinks and broken links on a note', async () => {
    const target = (await add({ path: 'Гарантия', body: 'Год.' })).json();
    await add({ path: 'Двери', body: 'Смотри [[Гарантия]] и [[Монтаж]].' });

    const res = await app.inject({ method: 'GET', url: `${notes()}/${target.id}`, cookies: jar });
    expect(res.json().backlinks.map((l: { title: string }) => l.title)).toEqual(['Двери']);

    const from = await app.inject({
      method: 'GET',
      url: `${notes()}/${res.json().backlinks[0]!.noteId}`,
      cookies: jar,
    });
    expect(from.json().links).toContainEqual({ noteId: null, title: 'Монтаж' });
  });

  it('renames a note through the route, re-pointing links that named it', async () => {
    // The rename has to move the *title*, not just the folder: a link is matched by title
    // (see `resolveLinks`), so a folder-only move leaves an already-correct link untouched
    // and would pass this test even with `resolveLinks` deleted from `saveNote`. Writing
    // «Двери»'s link against the title the target is about to take — not the one it has now
    // — means the link starts broken (nothing is titled «Гарантии» yet) and only resolves
    // once the rename below actually lands, so the assertion below is proof the rename made
    // it resolve, not proof it was already resolved.
    const target = (await add({ path: 'Гарантия', body: 'Год.' })).json();
    await add({ path: 'Двери', body: 'Смотри [[Гарантии]].' });

    const before = await app.inject({ method: 'GET', url: `${notes()}/${target.id}`, cookies: jar });
    expect(before.json().backlinks).toEqual([]);

    const res = await app.inject({
      method: 'PATCH',
      url: `${notes()}/${target.id}`,
      cookies: jar,
      payload: { path: 'Сервис/Гарантии' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().path).toBe('Сервис/Гарантии');
    expect(res.json().edited).toBe(true);

    const from = await app.inject({ method: 'GET', url: `${notes()}/${target.id}`, cookies: jar });
    expect(from.json().backlinks.map((l: { title: string }) => l.title)).toEqual(['Двери']);
  });

  it('refuses a PATCH rename onto an occupied path in the operator language', async () => {
    await add({ path: 'Двери', body: 'Раз.' });
    const other = (await add({ path: 'Окна', body: 'Два.' })).json();

    const res = await app.inject({
      method: 'PATCH',
      url: `${notes()}/${other.id}`,
      cookies: jar,
      payload: { path: 'Двери' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().message).toBe('Заметка с таким названием уже есть');
  });

  it('marks a body-only PATCH as edited', async () => {
    const note = (await add({ path: 'Двери', body: 'Металл.' })).json();
    expect(note.edited).toBe(false);

    const res = await app.inject({
      method: 'PATCH',
      url: `${notes()}/${note.id}`,
      cookies: jar,
      payload: { body: 'Дерево.' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().edited).toBe(true);
    expect(res.json().body).toBe('Дерево.');
  });

  it('deletes a note and its sections', async () => {
    const note = (await add({ path: 'Двери', body: '## Цена\n80 000 ₸.' })).json();

    expect((await app.inject({ method: 'DELETE', url: `${notes()}/${note.id}`, cookies: jar })).statusCode).toBe(
      200,
    );
    expect(await db.select().from(kbChunks).where(eq(kbChunks.noteId, note.id))).toEqual([]);
    expect((await app.inject({ method: 'GET', url: `${notes()}/${note.id}`, cookies: jar })).statusCode).toBe(404);
  });

  it('answers the graph with notes and resolved links only', async () => {
    await add({ path: 'Гарантия', body: 'Год.' });
    await add({ path: 'Двери', body: '[[Гарантия]] и [[Монтаж]]' });

    const res = await app.inject({ method: 'GET', url: graph(), cookies: jar });

    expect(res.json().notes).toHaveLength(2);
    expect(res.json().links).toHaveLength(1);
    expect(res.json().truncated).toBe(false);
  });

  it('lets a member write a note and refuses them a source', async () => {
    const memberJar = await login('member@example.com');

    const note = await app.inject({
      method: 'POST',
      url: notes(),
      cookies: memberJar,
      payload: { path: 'Двери', body: 'Металл.' },
    });
    expect(note.statusCode).toBe(200);

    const source = await app.inject({
      method: 'POST',
      url: `${sources()}/text`,
      cookies: memberJar,
      payload: { title: 'Прайс', text: 'Двери\n80 000 ₸.' },
    });
    expect(source.statusCode).toBe(403);
  });

  it('refuses a note belonging to another agent with 404', async () => {
    const note = (await add({ path: 'Двери', body: 'Металл.' })).json();

    const other = await createAccountWithOwner(db, {
      company: 'Другая',
      email: 'other@example.com',
      name: 'Другой',
      initials: 'ДР',
      password: PASSWORD,
    });
    const otherJar = await login('other@example.com');
    const otherAgent = await app.inject({
      method: 'POST',
      url: `/api/accounts/${other.accountId}/agents`,
      cookies: otherJar,
      payload: { name: 'Другая' },
    });

    const res = await app.inject({
      method: 'GET',
      cookies: otherJar,
      url: `/api/agents/${otherAgent.json().id}/knowledge/notes/${note.id}`,
    });
    expect(res.statusCode).toBe(404);
  });
});
