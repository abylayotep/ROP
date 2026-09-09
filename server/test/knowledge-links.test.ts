import { describe, expect, it } from 'vitest';
import { parseLinks } from '../src/lib/knowledge/links.js';

describe('parseLinks', () => {
  it('finds a plain link', () => {
    expect(parseLinks('Смотри [[Доставка]] и [[Гарантия]].')).toEqual(['Доставка', 'Гарантия']);
  });

  it('drops the label half', () => {
    expect(parseLinks('[[Доставка|как везём]]')).toEqual(['Доставка']);
  });

  it('returns each target once', () => {
    expect(parseLinks('[[Доставка]] и снова [[доставка]]')).toEqual(['Доставка']);
  });

  it('ignores a link inside a fenced block', () => {
    expect(parseLinks('```\n[[Доставка]]\n```\n[[Гарантия]]')).toEqual(['Гарантия']);
  });

  it('ignores an empty or whitespace target', () => {
    expect(parseLinks('[[]] [[   ]]')).toEqual([]);
  });

  it('does not catastrophically backtrack on a body of unclosed brackets at the note-size cap', () => {
    const body = '[['.repeat(100000);
    const start = performance.now();
    const result = parseLinks(body);
    const elapsed = performance.now() - start;
    expect(result).toEqual([]);
    expect(elapsed).toBeLessThan(1000);
  });

  it('does not let a target span a newline', () => {
    expect(parseLinks('[[unclosed start\nmore text later]] end')).toEqual([]);
  });

  it('ignores a link after an unclosed fenced block', () => {
    expect(parseLinks('```\nno closing fence\n[[Доставка]]')).toEqual([]);
  });
});
