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
});
