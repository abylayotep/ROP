import { describe, expect, it } from 'vitest';
import { assembleRules } from '../src/lib/ai/rules.js';

describe('assembleRules', () => {
  it('groups rules under their Russian headings in a fixed order', () => {
    const text = assembleRules([
      { category: 'forbid', text: 'Не обещай скидку.' },
      { category: 'business', text: 'Ставим двери в Алматы с 2015 года.' },
      { category: 'tone', text: 'Коротко, на «вы».' },
    ]);
    expect(text).toBe(
      'О компании\n- Ставим двери в Алматы с 2015 года.\n\n' +
      'Как говорить\n- Коротко, на «вы».\n\n' +
      'Чего не делать\n- Не обещай скидку.',
    );
  });

  it('skips a heading with no rules under it', () => {
    expect(assembleRules([{ category: 'tone', text: 'На «вы».' }]))
      .toBe('Как говорить\n- На «вы».');
  });

  it('keeps the order rules were given in inside a category', () => {
    const text = assembleRules([
      { category: 'order', text: 'Сначала район.' },
      { category: 'order', text: 'Потом сроки.' },
    ]);
    expect(text).toBe('О чём спрашивать\n- Сначала район.\n- Потом сроки.');
  });

  it('is empty for no rules, exactly as an empty field was', () => {
    expect(assembleRules([])).toBe('');
  });
});
