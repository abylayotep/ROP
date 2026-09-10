# Vault Knowledge Base — Part 3: the note routes

> Part of [the vault plan](2026-09-08-vault-knowledge-base.md). Read its header and **Global Constraints** before starting, and use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to work through the tasks. Steps use checkbox (`- [ ]`) syntax.

**Spec:** [docs/superpowers/specs/2026-09-08-obsidian-knowledge-base-design.md](../specs/2026-09-08-obsidian-knowledge-base-design.md)

---

### Task 6: The contract

**Files:**
- Modify: `packages/contract/index.ts:230-286`

**Interfaces:**
- Produces: `KbNoteKind`, `KbNote`, `KbNoteDetail`, `KbSection`, `KbGraph`. `KbItem` is deleted. `KbSource`, `KbImport` keep their names; `KbImport.items` becomes `KbImport.notes: KbNote[]`.

- [ ] **Step 1: Write the types**

```ts
export type KbNoteKind = 'product' | 'qa' | 'procedure' | 'contact' | 'other';

/** A note as a list or a tree shows it: enough to draw a row, not the body. */
export interface KbNote {
  id: string;
  /** «Товары/Двери входные». Folders are the segments before the last slash. */
  path: string;
  title: string;
  kind: KbNoteKind;
  tags: string[];
  edited: boolean;
  sourceId: string | null;
  sourceTitle: string | null;
  updatedAt: string;
}

/** One section of a note: what search ranks and what the agent quotes. */
export interface KbSection {
  id: string;
  noteId: string;
  /** «Доставка › По городу», so an answer says where in the note to look. */
  title: string;
  heading: string;
  content: string;
}

export interface KbLinkRef {
  noteId: string | null;
  title: string;
}

/** A note opened: its text, its sections, and what points at it. */
export interface KbNoteDetail extends KbNote {
  body: string;
  sections: KbSection[];
  /** Notes that link here. */
  backlinks: KbLinkRef[];
  /** What this note links to. `noteId` null is a link whose target does not exist. */
  links: KbLinkRef[];
}

/** The graph tab. Capped at 500 notes; `truncated` says the cap was hit. */
export interface KbGraph {
  notes: { id: string; title: string; path: string }[];
  links: { from: string; to: string }[];
  truncated: boolean;
}
```

- [ ] **Step 2: Typecheck**

Run from `server/`: `npm run typecheck`
Expected: FAIL, listing every place that still names `KbItem` — that list is Tasks 7 and 8's work.

- [ ] **Step 3: Commit**

```bash
git add packages/contract/index.ts
git commit -m "Name notes, sections and the graph in the contract"
```

---

### Task 7: Note routes

**Files:**
- Modify: `server/src/api/knowledge.ts` (replace the four item routes and the search route)
- Modify: `server/test/knowledge-api.test.ts`

**Interfaces:**
- Consumes: `saveNote`, `deleteNote`, `searchKnowledge`, `kbChunkColumns`.
- Produces: `GET /notes`, `GET /notes/:noteId`, `POST /notes`, `PATCH /notes/:noteId`, `DELETE /notes/:noteId`, `GET /search`, `GET /graph`, all under `/api/agents/:agentId/knowledge`.

- [ ] **Step 1: Write the failing test**

Rewrite `server/test/knowledge-api.test.ts` against the note routes, keeping its login and membership helpers. Cases:

```ts
it('creates a note and answers it with its sections', async () => {
  const res = await app.inject({ method: 'POST', url: notes(), cookies: jar,
    payload: { path: 'Товары/Двери', body: '## Цена\n80 000 ₸.' } });
  expect(res.statusCode).toBe(200);
  expect(res.json().sections.map((s: { title: string }) => s.title)).toEqual(['Двери › Цена']);
});

it('refuses a second note at the same path in the operator language', async () => {
  await app.inject({ method: 'POST', url: notes(), cookies: jar, payload: { path: 'Двери', body: 'Раз.' } });
  const res = await app.inject({ method: 'POST', url: notes(), cookies: jar, payload: { path: 'Двери', body: 'Два.' } });
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

it('answers backlinks and broken links on a note', async () => {
  const target = (await add({ path: 'Гарантия', body: 'Год.' })).json();
  await add({ path: 'Двери', body: 'Смотри [[Гарантия]] и [[Монтаж]].' });
  const res = await app.inject({ method: 'GET', url: `${notes()}/${target.id}`, cookies: jar });
  expect(res.json().backlinks.map((l: { title: string }) => l.title)).toEqual(['Двери']);
  const from = await app.inject({ method: 'GET', url: `${notes()}/${res.json().backlinks[0]!.noteId}`, cookies: jar });
  expect(from.json().links).toContainEqual({ noteId: null, title: 'Монтаж' });
});

it('deletes a note and its sections', async () => {
  const note = (await add({ path: 'Двери', body: '## Цена\n80 000 ₸.' })).json();
  expect((await app.inject({ method: 'DELETE', url: `${notes()}/${note.id}`, cookies: jar })).statusCode).toBe(200);
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
  const note = await app.inject({ method: 'POST', url: notes(), cookies: memberJar,
    payload: { path: 'Двери', body: 'Металл.' } });
  expect(note.statusCode).toBe(200);
  const source = await app.inject({ method: 'POST', url: `${sources()}/text`, cookies: memberJar,
    payload: { title: 'Прайс', text: 'Двери\n80 000 ₸.' } });
  expect(source.statusCode).toBe(403);
});

it('refuses a note belonging to another agent with 404', async () => {
  const note = (await add({ path: 'Двери', body: 'Металл.' })).json();
  const other = await createAccountWithOwner(db, {
    company: 'Другая', email: 'other@example.com', password: PASSWORD });
  const res = await app.inject({ method: 'GET', cookies: await login('other@example.com'),
    url: `/api/agents/${other.agentId}/knowledge/notes/${note.id}` });
  expect(res.statusCode).toBe(404);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/knowledge-api.test.ts`
Expected: FAIL — 404 on every note route.

- [ ] **Step 3: Write the routes**

Replace the item routes in `server/src/api/knowledge.ts`. Validation with zod, in the file's existing style:

```ts
/**
 * A path is folders and a name. Bounded because it is an identity people type: a leading
 * slash, an empty segment or a tenth folder is a mistake we can name rather than store.
 */
const notePath = z
  .string()
  .trim()
  .min(1)
  .max(400)
  .refine((path) => !path.startsWith('/') && !path.endsWith('/'), 'Название не может начинаться или заканчиваться косой чертой')
  .refine((path) => path.split('/').every((part) => part.trim() !== ''), 'В названии есть пустая папка')
  .refine((path) => path.split('/').length <= 10, 'Слишком глубокая вложенность');

const createNote = z.object({ path: notePath, body: z.string().max(BODY_MAX).default('') });
const updateNote = z.object({ path: notePath.optional(), body: z.string().max(BODY_MAX).optional() });
```

`POST /notes` and `PATCH /notes/:noteId` call `saveNote` inside `db.transaction`, with `edited: true` on the PATCH. A unique-violation from Postgres (`code === '23505'`) becomes `new ApiError(409, 'Заметка с таким названием уже есть')`. `GET /notes` runs `searchKnowledge` when `q` is present and returns the distinct notes of the hits in rank order, otherwise lists by `updatedAt desc` at `LIST_LIMIT`. `GET /notes/:noteId` joins chunks and both directions of `kb_links`. `GET /graph` selects at most 501 notes, sets `truncated` from the overflow, and returns links whose `toNoteId` is not null.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/knowledge-api.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/api/knowledge.ts server/test/knowledge-api.test.ts
git commit -m "Serve notes, sections, backlinks and the graph"
```

---
