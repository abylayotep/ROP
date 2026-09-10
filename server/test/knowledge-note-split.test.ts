import { describe, expect, it } from 'vitest';
import { parseNote } from '../src/lib/knowledge/note.js';

const headings = (body: string) => parseNote(body).sections.map((s) => s.heading);

describe('parseNote', () => {
  it('starts a section at every heading level', () => {
    const parsed = parseNote('# Доставка\nПо городу.\n\n### Астана\n3000 ₸.');
    expect(parsed.sections).toEqual([
      { heading: 'Доставка', content: 'По городу.' },
      { heading: 'Астана', content: '3000 ₸.' },
    ]);
  });

  it('keeps the text before the first heading as a section with no heading', () => {
    expect(parseNote('Мы ставим двери.\n\n## Цены\n80 000 ₸.').sections[0]).toEqual({
      heading: '',
      content: 'Мы ставим двери.',
    });
  });

  it('drops a heading with nothing under it', () => {
    expect(headings('## Оглавление\n## Доставка\nПо городу.')).toEqual(['Доставка']);
  });

  it('does not read a hash inside a fenced block as a heading', () => {
    expect(headings('## Прайс\n```\n# 80 000 ₸\n```')).toEqual(['Прайс']);
  });

  it('reads frontmatter and removes it from the body', () => {
    const parsed = parseNote('---\nkind: product\ntags: [двери, металл]\n---\n\nЦена 80 000 ₸.');
    expect(parsed.kind).toBe('product');
    expect(parsed.tags).toEqual(['двери', 'металл']);
    expect(parsed.sections).toEqual([{ heading: '', content: 'Цена 80 000 ₸.' }]);
  });

  it('keeps an unparseable frontmatter block as text', () => {
    const parsed = parseNote('---\n: : :\n---\nЦена.');
    expect(parsed.kind).toBe('other');
    expect(parsed.sections[0]!.content.startsWith('---')).toBe(true);
  });

  it('cuts a section over the content limit on a paragraph boundary', () => {
    const body = `## Прайс\n${'а'.repeat(5000)}\n\n${'б'.repeat(5000)}`;
    const sections = parseNote(body).sections;
    expect(sections).toHaveLength(2);
    expect(sections.every((s) => s.content.length <= 8000)).toBe(true);
    expect(sections[1]!.content.startsWith('б')).toBe(true);
  });

  it('returns nothing for a body with no text in it', () => {
    expect(parseNote('   \n\n ').sections).toEqual([]);
  });
});
