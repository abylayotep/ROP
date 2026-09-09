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
