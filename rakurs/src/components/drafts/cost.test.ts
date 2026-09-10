import { describe, expect, it } from 'vitest';
import { describeRun } from './cost.js';

const cases = (n: number) => Array.from({ length: n }, (_, i) => ({ id: String(i) }) as never);

describe('describeRun', () => {
  it('counts both sides when nothing is cached', () => {
    expect(describeRun(cases(3), new Set()))
      .toBe('3 проверки: 6 вызовов модели плюс 3 сравнения');
  });

  it('says the baselines are taken from a previous run', () => {
    expect(describeRun(cases(3), new Set(['0', '1', '2'])))
      .toBe('3 проверки: 3 вызова модели (прежние ответы взяты из прошлого прогона) плюс 3 сравнения');
  });

  it('counts a mixed set', () => {
    expect(describeRun(cases(3), new Set(['0'])))
      .toBe('3 проверки: 5 вызовов модели плюс 3 сравнения');
  });

  it('declines the Russian noun for one and for five', () => {
    expect(describeRun(cases(1), new Set())).toContain('1 проверка');
    expect(describeRun(cases(5), new Set())).toContain('5 проверок');
  });
});
