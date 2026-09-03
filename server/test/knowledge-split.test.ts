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

  it('drops the control characters a paste carries out of a PDF', () => {
    // NUL and its neighbours are artefacts of where the text was copied from, not something
    // the owner typed or can see to remove. Postgres will not hold a NUL at all.
    expect(splitBlocks('Дверь\u0000 входная\nЦена\u000B 90 000.')).toEqual([
      { title: 'Дверь входная', content: 'Цена 90 000.' },
    ]);
  });

  it('returns nothing for text that is only control characters', () => {
    expect(splitBlocks('\u0000\u0001\u0000')).toEqual([]);
  });

  it('trims a title to the column and keeps the whole line in the content', () => {
    const long = 'Д'.repeat(260);
    const [part] = splitBlocks(`${long}\nЦена 90 000.`);

    // Exactly the column, not merely inside it: `<=` alone would also pass for an empty
    // title, which is the failure this is here to catch. The ellipsis is what tells the
    // owner the title was cut rather than typed that way.
    expect(part!.title).toHaveLength(200);
    expect(part!.title.endsWith('…')).toBe(true);
    // The title column stops at 200. Cutting the content instead would lose the fact.
    expect(part!.content).toBe('Цена 90 000.');
  });

  it('cuts a title on whole characters', () => {
    // A surrogate pair cut in half is a lone surrogate: not valid UTF-8, so it reaches the
    // database as `�` if it reaches it at all.
    const [part] = splitBlocks(`${'д'.repeat(198)}🚪🚪🚪\nЦена.`);

    expect(part!.title.length).toBeLessThanOrEqual(200);
    expect(part!.title).toBe(`${'д'.repeat(198)}…`);
  });

  it('cuts a block longer than the content column into several items', () => {
    const parts = splitBlocks(`Прайс\n${'строка. '.repeat(2000)}`);

    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => part.content.length <= 8000)).toBe(true);
    // The continuation says which item it continues, so a search hit still reads sensibly.
    expect(parts[1]!.title).toContain('Прайс');
    expect(parts[1]!.title).toContain('(2)');
  });

  it('keeps the number on a continuation whose title already fills the column', () => {
    // Clamping the title after the number was appended truncated the number away, so every
    // piece of a long body came back under one identical title.
    const parts = splitBlocks(`${'Д'.repeat(260)}\n${'строка. '.repeat(2000)}`);

    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => part.title.length <= 200)).toBe(true);
    expect(parts[1]!.title.endsWith('(2)')).toBe(true);
    expect(new Set(parts.map((part) => part.title)).size).toBe(parts.length);
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

  it('drops control characters before it splits', () => {
    // Task 4 feeds this a fetched page, which carries the same artefacts a paste does.
    expect(splitByHeadings('# Контакты\u0000\nАлматы\u0001, Абая 1.')).toEqual([
      { title: 'Контакты', content: 'Алматы, Абая 1.' },
    ]);
  });

  it('prefers a paragraph break to a line break when cutting a long section', () => {
    // A blank line separates blocks before `splitBlocks` ever cuts, so a section under a
    // heading is the only body that reaches the cutter with a paragraph break inside it.
    // Both breaks are in the window and past the halfway mark; the paragraph break is the
    // cheaper cut, so it wins even though the line break is later.
    const parts = splitByHeadings(
      `# Прайс\n${'а'.repeat(5000)}\n\nВторой абзац.\n${'б'.repeat(4000)}`,
    );

    expect(parts).toHaveLength(2);
    expect(parts[0]!.content).toBe('а'.repeat(5000));
    expect(parts[1]!.content.startsWith('Второй абзац.')).toBe(true);
  });
});
