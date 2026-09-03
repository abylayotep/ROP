### Task 3: Importing pasted text

**Files:**
- Create: `server/src/lib/knowledge/split.ts`
- Modify: `server/src/api/knowledge.ts` (one route)
- Modify: `packages/contract/index.ts` (`KbImport`)
- Create: `server/test/knowledge-split.test.ts`
- Create: `server/test/knowledge-import-text.test.ts`

**Interfaces:**
- Consumes: `kbItems`, `kbSources`, `requireAgent`, `toKbItem` from task 2.
- Produces: `splitBlocks(text)` and `splitByHeadings(text)` from `server/src/lib/knowledge/split.ts` — task 4 reuses the second; the route `POST /api/agents/:agentId/knowledge/import/text` → `KbImport`, owner-only.

**Context.** The fastest way a seller fills the store: paste a price list or a page of answers, and get back items they can correct on the spot. It runs inside the request and answers with what it made, so nobody waits on a queue to find out it split their text wrongly.

**The rule, and it is the whole of it.** Blocks are separated by a blank line. The first line of a block is the title, the rest is the content. A block with only one line is an item whose title and content are that line — because a one-line fact is still a fact, and refusing it would make an owner add a second line to say nothing.

- [ ] **Step 1: Write the failing test for the splitter**

Create `server/test/knowledge-split.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { splitBlocks, splitByHeadings } from '../src/lib/knowledge/split.js';

describe('splitBlocks', () => {
  it('splits on a blank line and takes the first line as the title', () => {
    const parts = splitBlocks(
      'Доставка\nПо Алматы бесплатно.\nВ Астану 3000 тенге.\n\nГарантия\nДвенадцать месяцев.',
    );

    expect(parts).toEqual([
      { title: 'Доставка', content: 'По Алматы бесплатно.\nВ Астану 3000 тенге.' },
      { title: 'Гарантия', content: 'Двенадцать месяцев.' },
    ]);
  });

  it('makes one item out of a block with nothing to split on', () => {
    // A one-line fact is still a fact. Refusing it would make an owner pad their text.
    expect(splitBlocks('Работаем с 9 до 18.')).toEqual([
      { title: 'Работаем с 9 до 18.', content: 'Работаем с 9 до 18.' },
    ]);
  });

  it('treats several blank lines as one separator', () => {
    expect(splitBlocks('Первый\nОдин.\n\n\n\nВторой\nДва.')).toHaveLength(2);
  });

  it('handles Windows line endings', () => {
    const parts = splitBlocks('Доставка\r\nПо Алматы.\r\n\r\nГарантия\r\nГод.');

    expect(parts).toEqual([
      { title: 'Доставка', content: 'По Алматы.' },
      { title: 'Гарантия', content: 'Год.' },
    ]);
  });

  it('ignores whitespace-only blocks and trailing blank lines', () => {
    expect(splitBlocks('\n\n   \n\nДоставка\nПо Алматы.\n\n   \n')).toEqual([
      { title: 'Доставка', content: 'По Алматы.' },
    ]);
  });

  it('returns nothing for text that is only whitespace', () => {
    expect(splitBlocks('   \n\n  \t ')).toEqual([]);
    expect(splitBlocks('')).toEqual([]);
  });

  it('trims a title to the column and keeps the whole line in the content', () => {
    const long = 'Д'.repeat(260);
    const [part] = splitBlocks(`${long}\nЦена 90 000.`);

    // The title column stops at 200. Cutting the content instead would lose the fact.
    expect(part!.title.length).toBeLessThanOrEqual(200);
    expect(part!.content).toBe('Цена 90 000.');
  });

  it('cuts a block longer than the content column into several items', () => {
    const parts = splitBlocks(`Прайс\n${'строка. '.repeat(2000)}`);

    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => part.content.length <= 8000)).toBe(true);
    // The continuation says which item it continues, so a search hit still reads sensibly.
    expect(parts[1]!.title).toContain('Прайс');
  });
});

describe('splitByHeadings', () => {
  it('makes an item per heading', () => {
    const parts = splitByHeadings([
      '# Сафина',
      'Двери и окна в Алматы.',
      '## Доставка',
      'По городу бесплатно.',
      '## Гарантия',
      'Двенадцать месяцев.',
    ].join('\n'));

    expect(parts.map((part) => part.title)).toEqual(['Сафина', 'Доставка', 'Гарантия']);
    expect(parts[1]!.content).toBe('По городу бесплатно.');
  });

  it('makes one item out of a page with no headings', () => {
    const parts = splitByHeadings('Просто текст.\nЕщё строка.');

    expect(parts).toHaveLength(1);
    expect(parts[0]!.content).toContain('Просто текст.');
  });

  it('drops a heading with nothing under it', () => {
    // A navigation label that survived the strip is a heading with no text. It is not a fact.
    const parts = splitByHeadings('# Меню\n## Контакты\nАлматы, Абая 1.');

    expect(parts.map((part) => part.title)).toEqual(['Контакты']);
  });

  it('returns nothing for empty text', () => {
    expect(splitByHeadings('   ')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm --prefix server test -- knowledge-split
```

Expected: the module does not exist.

- [ ] **Step 3: Write the splitter**

Create `server/src/lib/knowledge/split.ts`:

```ts
/** The knowledge columns' limits, kept beside the code that has to respect them. */
export const TITLE_MAX = 200;
export const CONTENT_MAX = 8000;

export interface SplitPart {
  title: string;
  content: string;
}

const clampTitle = (line: string): string =>
  line.length <= TITLE_MAX ? line : `${line.slice(0, TITLE_MAX - 1)}…`;

/**
 * Cuts a body too long for its column into pieces, on a paragraph break where there is one
 * and on a space otherwise.
 *
 * A hard slice at 8000 would land in the middle of a word and, more to the point, in the
 * middle of a price.
 */
function cut(content: string): string[] {
  if (content.length <= CONTENT_MAX) return [content];

  const pieces: string[] = [];
  let rest = content;
  while (rest.length > CONTENT_MAX) {
    const window = rest.slice(0, CONTENT_MAX);
    const at = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'), window.lastIndexOf(' '));
    const end = at > CONTENT_MAX / 2 ? at : CONTENT_MAX;
    pieces.push(rest.slice(0, end).trim());
    rest = rest.slice(end).trim();
  }
  if (rest !== '') pieces.push(rest);
  return pieces;
}

/** One part per piece, numbered when there is more than one so a hit still reads sensibly. */
function toParts(title: string, content: string): SplitPart[] {
  const pieces = cut(content);
  if (pieces.length === 1) return [{ title: clampTitle(title), content: pieces[0]! }];
  return pieces.map((piece, index) => ({
    title: clampTitle(`${title} (${index + 1})`),
    content: piece,
  }));
}

const normalise = (text: string): string => text.replace(/\r\n?/g, '\n');

/**
 * A pasted block becomes items: blank lines separate them, the first line names each one.
 *
 * The rule is simple enough that an owner can predict it from one look at the result, which
 * matters more here than any cleverness — they are going to paste, look, and paste again.
 */
export function splitBlocks(text: string): SplitPart[] {
  return normalise(text)
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block !== '')
    .flatMap((block) => {
      const [first = '', ...rest] = block.split('\n');
      const body = rest.join('\n').trim();
      // A single line is its own title and its own content: a one-line fact is still a
      // fact, and refusing it would make an owner pad their text to satisfy us.
      return toParts(first.trim(), body === '' ? first.trim() : body);
    });
}

/**
 * A page's text becomes items: a markdown heading starts one, the text under it is the body.
 *
 * A heading with nothing under it is dropped — that is a navigation label that survived the
 * strip, not a fact. A page with no headings is one item, because the alternative is
 * throwing away everything the owner asked us to read.
 */
export function splitByHeadings(text: string): SplitPart[] {
  const lines = normalise(text).split('\n');
  const parts: SplitPart[] = [];

  let title: string | null = null;
  let buffer: string[] = [];

  const flush = () => {
    const content = buffer.join('\n').trim();
    buffer = [];
    if (content === '') return;
    parts.push(...toParts(title ?? content.split('\n')[0]!.trim(), content));
  };

  for (const line of lines) {
    const heading = /^#{1,6}\s+(.*\S)\s*$/.exec(line);
    if (heading) {
      flush();
      title = heading[1]!;
      continue;
    }
    buffer.push(line);
  }
  flush();

  return parts;
}
```

- [ ] **Step 4: Write the failing test for the route**

Create `server/test/knowledge-import-text.test.ts`. Build it on the same fixture as
`server/test/knowledge-api.test.ts` — copy that file's `beforeEach`, `afterEach` and
`login` helper verbatim — then add:

```ts
const importText = (payload: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: `/api/agents/${agentId}/knowledge/import/text`,
    cookies: jar,
    payload,
  });

describe('importing pasted text', () => {
  it('creates a source and its items, and answers with both', async () => {
    const res = await importText({
      title: 'Прайс-лист',
      kind: 'product',
      text: 'Дверь входная\nОт 90 000 тенге.\n\nОкно\nОт 40 000 тенге.',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().source.status).toBe('ready');
    expect(res.json().source.itemCount).toBe(2);
    expect(res.json().items).toHaveLength(2);
    expect(res.json().items[0].kind).toBe('product');
    expect(res.json().items[0].sourceTitle).toBe('Прайс-лист');
  });

  it('defaults the kind to other', async () => {
    const res = await importText({ title: 'Заметки', text: 'Работаем с 9 до 18.' });

    expect(res.json().items[0].kind).toBe('other');
  });

  it('refuses text that holds nothing', async () => {
    const res = await importText({ title: 'Пусто', text: '   \n\n  ' });

    expect(res.statusCode).toBe(400);
    expect(await db.select().from(kbSources)).toHaveLength(0);
    expect(await db.select().from(kbItems)).toHaveLength(0);
  });

  it('refuses a paste larger than we will store', async () => {
    const res = await importText({ title: 'Много', text: 'а'.repeat(200_001) });

    expect(res.statusCode).toBe(400);
    expect(await db.select().from(kbSources)).toHaveLength(0);
  });

  it('is refused for a member', async () => {
    const memberJar = await login('member@example.com');

    const res = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/knowledge/import/text`,
      cookies: memberJar,
      payload: { title: 'Прайс', text: 'Дверь\nЦена.' },
    });

    expect(res.statusCode).toBe(403);
  });

  it('makes the imported items searchable', async () => {
    await importText({ title: 'Прайс', text: 'Дверь входная\nМеталлическая, Алматы.' });

    const found = await app.inject({
      url: `/api/agents/${agentId}/knowledge/items?q=металлическая`,
      cookies: jar,
    });

    expect(found.json()).toHaveLength(1);
  });
});
```

- [ ] **Step 5: Extend the contract**

Append to `packages/contract/index.ts`:

```ts
/** What an import produced, answered by the import routes so the owner sees it at once. */
export interface KbImport {
  source: KbSource;
  items: KbItem[];
}
```

- [ ] **Step 6: Write the route**

In `server/src/api/knowledge.ts`, add `requireAgent(db, { role: 'owner' })` as `ownerOnly`,
export a helper both import routes will use, and add the text route:

```ts
/** A paste bigger than this is a file, not a note, and files are not this stage. */
const PASTE_MAX = 200_000;

const importText = z.object({
  title: z.string().trim().min(1).max(TITLE_MAX),
  kind: z.enum(KINDS).default('other'),
  text: z.string().max(PASTE_MAX),
});
```

```ts
  /**
   * Writes a finished import: the source, then its items, in one transaction.
   *
   * Shared with task 4's page import, which differs only in where the parts came from.
   */
  async function storeImport(
    agentId: string,
    source: typeof kbSources.$inferInsert,
    kind: (typeof KINDS)[number],
    parts: SplitPart[],
  ): Promise<KbImport> {
    return db.transaction(async (tx) => {
      const [created] = await tx
        .insert(kbSources)
        .values({ ...source, agentId, status: 'ready', itemCount: parts.length, importedAt: new Date() })
        .returning();

      const rows = await tx
        .insert(kbItems)
        .values(
          parts.map((part) => ({
            agentId,
            sourceId: created!.id,
            kind,
            title: part.title,
            content: part.content,
          })),
        )
        .returning();

      return { source: toKbSource(created!), items: rows.map((row) => toKbItem(row, created!.title)) };
    });
  }

  app.post(
    '/api/agents/:agentId/knowledge/import/text',
    { preHandler: [guard, ownerOnly] },
    async (req): Promise<KbImport> => {
      const parsed = importText.safeParse(req.body);
      if (!parsed.success) {
        throw new ApiError(400, `Укажите название и текст не длиннее ${PASTE_MAX} символов`);
      }

      const parts = splitBlocks(parsed.data.text);
      // Refused before anything is written: a source with no items is a row that says an
      // import happened and shows nothing for it.
      if (parts.length === 0) throw new ApiError(400, 'В тексте нечего сохранить');

      return storeImport(
        req.agent!.id,
        { kind: 'text', title: parsed.data.title },
        parsed.data.kind,
        parts,
      );
    },
  );
```

Import `splitBlocks` and the type `SplitPart` from `../lib/knowledge/split.js`, and
`KbImport` from the contract.

- [ ] **Step 7: Run the tests**

```bash
npm --prefix server test
npm --prefix server run typecheck
npm --prefix rakurs run typecheck
```

- [ ] **Step 8: Commit**

```bash
git add server packages/contract/index.ts
git commit -m "Turn a pasted block of text into knowledge items"
```
