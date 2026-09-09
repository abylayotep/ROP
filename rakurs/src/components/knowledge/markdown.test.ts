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

  it('reads a heading level off the number of `#`', () => {
    const nodes = renderMarkdown('## Цена', new Set());
    expect(nodes).toEqual([{ kind: 'heading', level: 2, children: [{ kind: 'text', text: 'Цена' }] }]);
  });

  it('reads bold text between `**`', () => {
    const nodes = renderMarkdown('**80 000 ₸**', new Set());
    expect(nodes).toEqual([{ kind: 'bold', text: '80 000 ₸' }]);
  });

  it('reads italic text between `_`', () => {
    const nodes = renderMarkdown('_включая доставку_', new Set());
    expect(nodes).toEqual([{ kind: 'italic', text: 'включая доставку' }]);
  });

  it('reads a bulleted list as one list-item node per line', () => {
    const nodes = renderMarkdown('- Раз\n- Два', new Set());
    expect(nodes).toEqual([
      { kind: 'list-item', ordered: false, children: [{ kind: 'text', text: 'Раз' }] },
      { kind: 'list-item', ordered: false, children: [{ kind: 'text', text: 'Два' }] },
    ]);
  });

  it('reads a `> ` line as a blockquote', () => {
    const nodes = renderMarkdown('> Гарантия год.', new Set());
    expect(nodes).toEqual([{ kind: 'blockquote', children: [{ kind: 'text', text: 'Гарантия год.' }] }]);
  });

  // Three malformed inputs, each answered by falling back to plain text rather than by
  // guessing at what was meant or throwing — a note is someone's own writing, imported or
  // typed by hand, and a typo in it must not break the screen that shows it.

  it('never closes a fence that has no closing ``` — the rest of the note becomes its content', () => {
    const nodes = renderMarkdown('```\nтекст без закрытия', new Set());
    expect(nodes).toEqual([{ kind: 'code', text: 'текст без закрытия' }]);
  });

  it('leaves a `[[` with no `]]` anywhere after it as plain text', () => {
    const nodes = renderMarkdown('Смотри [[Гарантия без закрытия', new Set());
    expect(nodes).toEqual([{ kind: 'text', text: 'Смотри [[Гарантия без закрытия' }]);
  });

  it('leaves a wiki link with only one closing bracket as plain text', () => {
    const nodes = renderMarkdown('Смотри [[Гарантия].', new Set(['Гарантия']));
    expect(nodes).toEqual([{ kind: 'text', text: 'Смотри [[Гарантия].' }]);
  });
});
