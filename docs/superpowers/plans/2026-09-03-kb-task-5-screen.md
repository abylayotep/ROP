### Task 5: The knowledge screen

**Files:**
- Create: `rakurs/src/screens/KnowledgeScreen.tsx`
- Create: `rakurs/src/components/knowledge/ImportPanel.tsx`
- Modify: `rakurs/src/api/index.ts` (the knowledge calls)
- Modify: `rakurs/src/lib/sections.ts` (`knowledge` loses its placeholder)
- Modify: `rakurs/src/App.tsx` (route it)

**Interfaces:**
- Consumes: every knowledge route from tasks 2, 3 and 4; `useApi`, `useDebounced`, `Async`, `Card`, `CardHead`, `Segmented`, `EmptyState`, `RowsSkeleton`, `useToast`, `useAgent`.
- Produces: nothing other tasks read.

**Context.** Where an owner sees what the agent will see. The search box calls the same endpoint stage 5's agent will, so typing a customer's question here answers "would it find this?" — which is the only question that matters about a knowledge base.

**Comments in this file are English.** Only strings a person reads are Russian.

- [ ] **Step 1: Add the API calls**

In `rakurs/src/api/index.ts`, add the types to the import list — `KbImport`, `KbItem`,
`KbItemKind`, `KbSource` — and append:

```ts
// ── База знаний ──────────────────────────────────────────────────────────────

const knowledge = (agentId: string) => `/agents/${agentId}/knowledge`;

/**
 * С запросом это поиск, без него — список. Один маршрут на оба случая намеренно:
 * владелец должен проверять ровно тот поиск, которым на пятом этапе пользуется ИИ.
 */
export const listKbItems = (
  agentId: string,
  params: { kind?: KbItemKind; q?: string },
  signal?: AbortSignal,
) => request<KbItem[]>(`${knowledge(agentId)}/items`, { query: params, signal });

export const createKbItem = (
  agentId: string,
  body: { kind: KbItemKind; title: string; content: string },
) => request<KbItem>(`${knowledge(agentId)}/items`, { method: 'POST', body });

export const updateKbItem = (
  agentId: string,
  itemId: string,
  body: { kind?: KbItemKind; title?: string; content?: string },
) => request<KbItem>(`${knowledge(agentId)}/items/${itemId}`, { method: 'PATCH', body });

export const deleteKbItem = (agentId: string, itemId: string) =>
  request<{ ok: true }>(`${knowledge(agentId)}/items/${itemId}`, { method: 'DELETE' });

export const listKbSources = (agentId: string, signal?: AbortSignal) =>
  request<KbSource[]>(`${knowledge(agentId)}/sources`, { signal });

export const importKbText = (
  agentId: string,
  body: { title: string; kind: KbItemKind; text: string },
) => request<KbImport>(`${knowledge(agentId)}/import/text`, { method: 'POST', body });

export const importKbPage = (agentId: string, url: string) =>
  request<KbImport>(`${knowledge(agentId)}/import/page`, { method: 'POST', body: { url } });

export const reimportKbSource = (agentId: string, sourceId: string) =>
  request<KbImport>(`${knowledge(agentId)}/sources/${sourceId}/reimport`, { method: 'POST' });

export const deleteKbSource = (agentId: string, sourceId: string) =>
  request<{ ok: true }>(`${knowledge(agentId)}/sources/${sourceId}`, { method: 'DELETE' });
```

- [ ] **Step 2: Route the screen**

In `rakurs/src/lib/sections.ts`, replace the `knowledge` entry with:

```ts
  { path: 'knowledge', label: 'База знаний', pending: '' },
```

In `rakurs/src/App.tsx`, import `KnowledgeScreen` and add a branch for
`section.path === 'knowledge'`, in the same chain the other screens use.

- [ ] **Step 3: Write the import panel**

Create `rakurs/src/components/knowledge/ImportPanel.tsx`. It is a `Card` with two forms,
side by side is fine, and it is shown only to an owner — the screen decides that.

- **Paste**: a title input, a kind select (Товар / Вопрос-ответ / Процедура / Контакт /
  Другое), a textarea, and a submit. Below the textarea, one line saying the rule in the
  owner's words: пустая строка разделяет записи, первая строка каждой — заголовок.
- **A page**: a URL input and a submit.

Both call their API function, and on success call `onImported(result)` so the screen can
say what was made and reload. On failure they show the server's message through the toast —
it is written for this person, in their language, and says the actual reason.

Both submits are disabled while the request is in flight, and the page form says «Загружаем
страницу…» while it runs: a fetch takes seconds, and a button that does nothing visible for
five seconds gets pressed again.

Declare every sub-component at module scope.

- [ ] **Step 4: Write the screen**

Create `rakurs/src/screens/KnowledgeScreen.tsx`:

- A `Segmented` for the kind — «Все», «Товары», «Вопросы», «Процедуры», «Контакты»,
  «Другое» — and a search input, debounced with `useDebounced` so a keystroke is not a
  request.
- The list through `useApi`, keyed on `[agent.id, kind, debouncedQuery]`. Each row shows the
  title, the first part of the content, its kind, where it came from, and «изменено вручную»
  when `edited`. A row expands into an editable form — title, kind, content — with «Сохранить»
  and «Удалить». Deleting asks for confirmation naming the title.
- «Добавить запись» opens the same form empty.
- Three empty states, and they say different things: nothing in the base at all, nothing of
  this kind, and nothing matching this query. Say the query back to the person.
- The import panel above the list for an owner; a member sees the list and can still edit.
- Below the list, for an owner, the sources: title, when, how many items, «Обновить» for a
  page and «Удалить». A failed source shows its reason in red. «Удалить» explains that the
  items stay.

Follow the idiom of `rakurs/src/screens/CustomersScreen.tsx` and
`rakurs/src/components/lead/LeadPanel.tsx`: inline style objects, CSS custom properties,
every component at module scope, a mutation that answers with the row replaces state from
the answer rather than patching it locally, and a failed save leaves what the person typed
in the box.

- [ ] **Step 5: Check it compiles and builds**

```bash
npm --prefix rakurs run typecheck
npm --prefix rakurs run build
npm --prefix server run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add rakurs
git commit -m "Add the knowledge base screen"
```
