# Vault Knowledge Base — Part 4: imports, the agent and the screens

> Part of [the vault plan](2026-09-08-vault-knowledge-base.md). Read its header and **Global Constraints** before starting, and use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to work through the tasks. Steps use checkbox (`- [ ]`) syntax.

**Spec:** [docs/superpowers/specs/2026-09-08-obsidian-knowledge-base-design.md](../specs/2026-09-08-obsidian-knowledge-base-design.md)

---

### Task 8: Imports write notes

**Files:**
- Modify: `server/src/api/knowledge.ts` (the four source routes)
- Modify: `server/src/lib/knowledge/fetch-page.ts` (return markdown, not parts)
- Modify: `server/test/knowledge-import-text.test.ts`, `server/test/knowledge-page.test.ts`, `server/test/knowledge-fetch-page.test.ts`

**Interfaces:**
- Consumes: `saveNote`, `splitBlocks`.
- Produces: `fetchPage` returns `{ title: string; markdown: string }` — the page's headings kept as `#` lines — instead of `SplitPart[]`.

- [ ] **Step 1: Write the failing tests**

In `knowledge-fetch-page.test.ts`, replace the assertions on parts with:

```ts
it('keeps the page headings as markdown headings', async () => {
  const page = await fetchPage(url('<h1>Двери</h1><p>Металл.</p><h2>Доставка</h2><p>1500 ₸.</p>'));
  expect(page.title).toBe('Двери');
  expect(page.markdown).toBe('# Двери\n\nМеталл.\n\n## Доставка\n\n1500 ₸.');
});
```

In `knowledge-import-text.test.ts`:

```ts
it('makes a note per block under the paste folder', async () => {
  const res = await paste('Двери\nМеталл.\n\nДоставка\n1500 ₸.');
  expect(res.json().notes.map((n: { path: string }) => n.path))
    .toEqual(['Вставки/Двери', 'Вставки/Доставка']);
});

it('numbers a second paste of the same title rather than refusing it', async () => {
  await paste('Двери\nМеталл.');
  const res = await paste('Двери\nДерево.');
  expect(res.json().notes[0]!.path).toBe('Вставки/Двери (2)');
});
```

In `knowledge-page.test.ts`:

```ts
it('makes one note out of a page', async () => {
  const res = await importPage(html);
  expect(res.json().notes).toHaveLength(1);
  expect(res.json().notes[0]!.path).toBe('С сайта/Двери');
});

it('replaces an untouched note on refresh and keeps an edited one', async () => {
  const first = await importPage('<h1>Двери</h1><p>80 000 ₸.</p>');
  const noteId = first.json().notes[0]!.id;
  await app.inject({ method: 'PATCH', url: `${notes()}/${noteId}`, cookies: jar,
    payload: { body: '# Двери\n\n90 000 ₸.' } });
  const again = await refresh();
  expect(again.json().keptEdited).toBe(1);
  const kept = await app.inject({ method: 'GET', url: `${notes()}/${noteId}`, cookies: jar });
  expect(kept.json().body).toContain('90 000 ₸.');
});

it('leaves the notes alone when the page fails to load', async () => {
  const first = await importPage('<h1>Двери</h1><p>80 000 ₸.</p>');
  server.fail(503);
  const again = await refresh();
  expect(again.json().source.status).toBe('failed');
  const still = await app.inject({ method: 'GET', url: `${notes()}/${first.json().notes[0]!.id}`, cookies: jar });
  expect(still.json().body).toContain('80 000 ₸.');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/knowledge-import-text.test.ts test/knowledge-page.test.ts test/knowledge-fetch-page.test.ts`
Expected: FAIL — the responses still carry `items`.

- [ ] **Step 3: Rewrite the import writers**

`fetch-page.ts`: the extraction, the allowlist, the 2 MB and 15 s limits and the encoding handling are untouched. Only the last step changes — instead of calling `splitByHeadings`, emit markdown: a heading becomes `#`×level plus its text, a paragraph becomes its text, blocks joined by a blank line. `splitByHeadings` loses its last caller and is deleted with its test.

`POST /sources/text`: `splitBlocks` still decides the blocks; each becomes `saveNote({ path: uniquePath('Вставки', part.title), body: part.content, sourceId })`. `uniquePath` appends ` (2)`, ` (3)` until the path is free for this agent.

`POST /sources/page`: one `saveNote` at `uniquePath('С сайта', page.title)` with the markdown.

`POST /sources/:id/refresh`: fetch first, then in one transaction delete the source's notes where `edited = false`, write the page again, and count the kept ones into `keptEdited`. `DELETE /sources/:id` sets `sourceId` null on its notes, as it does today.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/knowledge-import-text.test.ts test/knowledge-page.test.ts test/knowledge-fetch-page.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/api/knowledge.ts server/src/lib/knowledge server/test
git commit -m "Import a page and a paste as notes"
```

---

### Task 9: The agent quotes sections

**Files:**
- Modify: `server/src/lib/ai/turn.ts` (retrieval and `usedItemIds`)
- Modify: `server/src/db/schema.ts:544-548` (the comment on `usedItemIds`)
- Modify: `server/test/ai-turn.test.ts`, `server/test/ai-prompt.test.ts`

**Interfaces:**
- Consumes: `searchKnowledge` returning `{ chunk, rank }`.
- Produces: no signature change. `PromptKnowledge` keeps `{ id, title, content }`; `usedItemIds` holds chunk ids.

- [ ] **Step 1: Write the failing test**

```ts
// in server/test/ai-turn.test.ts
it('records the sections an answer was built from', async () => {
  await saveNote(db, { agentId, path: 'Доставка', body: '## По городу\n1500 ₸.' });
  const result = await runTurn(db, deps, { agentId, conversationId, dryRun: true });
  const [reply] = await db.select().from(aiReplies).where(eq(aiReplies.agentId, agentId));
  const [chunk] = await db.select().from(kbChunks).where(eq(kbChunks.agentId, agentId));
  expect(reply!.usedItemIds).toEqual([chunk!.id]);
  expect(result.outcome).toBe('unrecorded');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/ai-turn.test.ts`
Expected: FAIL — the fixtures still insert `kbItems`.

- [ ] **Step 3: Point the turn at chunks**

In `turn.ts`, the retrieval call now destructures `chunk` where it destructured `item`, and maps `{ id: chunk.id, title: chunk.title, content: chunk.content }` into `PromptKnowledge`. Nothing else moves: the number guard already reads `PromptKnowledge.content`, and six sections are less text than six records were. Update the `usedItemIds` comment in the schema to say it holds section ids and why the column keeps its name.

- [ ] **Step 4: Run the whole suite**

Run: `npm test`
Expected: PASS. Any remaining failure is a fixture still inserting `kbItems`; convert it to `saveNote`.

- [ ] **Step 5: Commit**

```bash
git add server/src server/test
git commit -m "Build a reply from sections and record which"
```

---

### Task 10: The vault screen

**Files:**
- Rewrite: `rakurs/src/screens/KnowledgeScreen.tsx`
- Create: `rakurs/src/components/knowledge/NoteTree.tsx`, `NoteEditor.tsx`, `NotePanel.tsx`, `markdown.ts`
- Modify: `rakurs/src/components/knowledge/ImportPanel.tsx` (it now reports notes)
- Modify: `rakurs/src/api/index.ts`
- Test: `rakurs/src/components/knowledge/markdown.test.ts`, `rakurs/src/components/knowledge/tree.test.ts`

**Interfaces:**
- Consumes: `KbNote`, `KbNoteDetail`, `KbSection`, `KbGraph` from `@rakurs/contract`.
- Produces: `export function buildTree(notes: KbNote[]): TreeNode[]` where `TreeNode = { name: string; path: string; children: TreeNode[]; note: KbNote | null }`; `export function renderMarkdown(body: string, titles: Set<string>): MarkdownNode[]`.

- [ ] **Step 1: Write the failing tests**

```ts
// rakurs/src/components/knowledge/tree.test.ts
import { describe, expect, it } from 'vitest';
import { buildTree } from './NoteTree.js';

const note = (path: string) => ({ id: path, path, title: path.split('/').pop()!, kind: 'other',
  tags: [], edited: false, sourceId: null, sourceTitle: null, updatedAt: '' }) as const;

describe('buildTree', () => {
  it('makes a folder out of a path segment', () => {
    const tree = buildTree([note('Товары/Двери'), note('Товары/Окна'), note('Доставка')]);
    expect(tree.map((n) => n.name)).toEqual(['Товары', 'Доставка']);
    expect(tree[0]!.children.map((n) => n.name)).toEqual(['Двери', 'Окна']);
  });

  it('puts folders before loose notes and sorts each alphabetically', () => {
    const tree = buildTree([note('Яблоко'), note('Б/Один'), note('А/Два')]);
    expect(tree.map((n) => n.name)).toEqual(['А', 'Б', 'Яблоко']);
  });
});
```

```ts
// rakurs/src/components/knowledge/markdown.test.ts
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './markdown.js';

describe('renderMarkdown', () => {
  it('marks a wiki link as broken when no note carries the title', () => {
    const nodes = renderMarkdown('Смотри [[Гарантия]].', new Set(['Доставка']));
    expect(nodes).toContainEqual({ kind: 'link', target: 'Гарантия', label: 'Гарантия', broken: true });
  });

  it('uses the label half when one is written', () => {
    const nodes = renderMarkdown('[[Доставка|как везём]]', new Set(['Доставка']));
    expect(nodes).toContainEqual({ kind: 'link', target: 'Доставка', label: 'как везём', broken: false });
  });

  it('leaves the text of a fenced block alone', () => {
    const nodes = renderMarkdown('```\n# не заголовок\n```', new Set());
    expect(nodes[0]).toEqual({ kind: 'code', text: '# не заголовок' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run from `rakurs/`: `npx vitest run src/components/knowledge`
Expected: FAIL — unresolved imports.

- [ ] **Step 3: Write the tree, the renderer and the panes**

`buildTree` groups by path segment, folders first, each level sorted with `localeCompare('ru')`. `renderMarkdown` supports headings, bold, italic, lists, links, inline code, fenced code and blockquotes, and emits `{ kind: 'link', target, label, broken }` for `[[…]]`. It is written here rather than pulled in: a renderer that passes HTML through would put page-authored markup into the cabinet.

`KnowledgeScreen` is three panes: `NoteTree` and the search box left, `NoteEditor` centre (textarea in edit mode, `renderMarkdown` output in view mode, `[[` offering titles), `NotePanel` right (backlinks, links, tags, source, and «Что найдёт агент» calling `GET /search`). Saving is an explicit button. Owner-only blocks stay owner-only: `ImportPanel` is unchanged in who sees it and changes only in reading `notes` where it read `items`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/knowledge` then `npm run build`
Expected: PASS, then a clean build.

- [ ] **Step 5: Commit**

```bash
git add rakurs/src
git commit -m "Show the knowledge base as a vault"
```

---

### Task 11: The graph tab

**Files:**
- Create: `rakurs/src/components/knowledge/Graph.tsx`, `rakurs/src/components/knowledge/layout.ts`
- Modify: `rakurs/src/screens/KnowledgeScreen.tsx` (the tab)
- Test: `rakurs/src/components/knowledge/layout.test.ts`

**Interfaces:**
- Consumes: `KbGraph`.
- Produces: `export function layout(graph: KbGraph, steps: number): Map<string, { x: number; y: number }>` — a deterministic force layout, seeded from note ids so the same vault draws the same picture twice.

- [ ] **Step 1: Write the failing test**

```ts
// rakurs/src/components/knowledge/layout.test.ts
import { describe, expect, it } from 'vitest';
import { layout } from './layout.js';

const graph = {
  notes: [{ id: 'a', title: 'А', path: 'А' }, { id: 'b', title: 'Б', path: 'Б' },
          { id: 'c', title: 'В', path: 'В' }],
  links: [{ from: 'a', to: 'b' }],
  truncated: false,
};

describe('layout', () => {
  it('places every note', () => {
    expect([...layout(graph, 50).keys()].sort()).toEqual(['a', 'b', 'c']);
  });

  it('is deterministic', () => {
    expect([...layout(graph, 50)]).toEqual([...layout(graph, 50)]);
  });

  it('pulls linked notes closer than unlinked ones', () => {
    const at = layout(graph, 200);
    const d = (x: string, y: string) =>
      Math.hypot(at.get(x)!.x - at.get(y)!.x, at.get(x)!.y - at.get(y)!.y);
    expect(d('a', 'b')).toBeLessThan(d('a', 'c'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/knowledge/layout.test.ts`
Expected: FAIL — unresolved import.

- [ ] **Step 3: Write the layout and the canvas**

`layout` is repulsion between every pair, attraction along links, positions seeded by hashing the note id so there is no `Math.random` and no animation frame in a testable function. `Graph.tsx` draws nodes and edges to a `<canvas>`, labels nodes above a zoom threshold, and opens a note on click. Read-only: there is no dragging an edge into existence, because a link is text in a note.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/knowledge/layout.test.ts` then `npm run build`
Expected: PASS, then a clean build.

- [ ] **Step 5: Commit**

```bash
git add rakurs/src
git commit -m "Draw the vault as a graph"
```

---

### Task 12: The owner's documentation

**Files:**
- Rewrite: `docs/knowledge-base.md`
- Modify: `docs/ai-agent.md` §1, §5, §12 (records become sections)

- [ ] **Step 1: Rewrite `docs/knowledge-base.md`**

Same voice, same audience — an owner who will not read code — and the same sections, renamed to what exists: a note, folders and paths, markdown and headings, `[[links]]` and the graph, pasting text, loading a page, refreshing, deleting a source, checking what the agent will find, and what goes wrong. Keep it Russian, keep it under 500 lines, and replace every «запись» that now means a note or a section with the one it means.

New paragraphs it must carry, because they are new behaviour an owner will otherwise discover the hard way:

- a heading starts a section, and a section is what reaches the agent — so a note may be long, but its headings must be real;
- a heading with nothing under it disappears;
- a link to a note that does not exist is shown broken and starts working the moment the note appears;
- renaming a note re-points the links written to its old title only if that title is what they say — a link is text, and text does not move on its own.

- [ ] **Step 2: Correct `docs/ai-agent.md`**

§1: the agent reads «до 6 разделов базы знаний», and the number guard checks against the sections cited. §5: the sandbox names sections. §12: the two rows about records name sections and say the note to open.

- [ ] **Step 3: Check the line counts**

Run: `wc -l docs/knowledge-base.md docs/ai-agent.md`
Expected: both under 500.

- [ ] **Step 4: Commit**

```bash
git add docs
git commit -m "Describe the vault the way an owner meets it"
```

---

