/**
 * Две фразы, которые карточка «Движение по воронке» печатает про саму себя.
 *
 * Обе проверяются здесь, а не глазами: одна печатает число, вторая — предложение, и обе
 * ошибались тихо. «0 %» выглядит как настоящий ответ, а «лидов не двигали» — как настоящее
 * предложение, и заметить их можно только на конкретных цифрах.
 */
import { describe, expect, it } from 'vitest';
import { chainAbsence, percent } from './stats';

/** Неразрывный пробел, тот же, что и в самой функции. */
const NBSP = '\u00a0';

describe('percent', () => {
  it('печатает целые проценты', () => {
    expect(percent(1)).toBe(`100${NBSP}%`);
    expect(percent(0.75)).toBe(`75${NBSP}%`);
    // Доля больше единицы законна: лида могли перетащить сюда мимо стадий выше.
    expect(percent(2)).toBe(`200${NBSP}%`);
  });

  it('не печатает «0 %» за долю, которой просто мало', () => {
    // Один лид из двухсот пятидесяти. Округление до целого давало «0 %» — ровно ту
    // строку, которую карточка приберегла для «доли нет вовсе»: ноль там обвиняет отдел в
    // потере лидов, а здесь лид как раз дошёл.
    expect(percent(1 / 250)).toBe(`<1${NBSP}%`);
    expect(percent(0.004)).toBe(`<1${NBSP}%`);
    // Ровно на границе округления — уже число, а не «меньше одного».
    expect(percent(0.005)).toBe(`1${NBSP}%`);
  });
});

describe('chainAbsence', () => {
  const report = (
    entered: number[],
    over: { failureEntries?: number; deletedStageEntries?: number } = {},
  ) => ({
    funnel: entered.map((value) => ({ entered: value })),
    failureEntries: over.failureEntries ?? 0,
    deletedStageEntries: over.deletedStageEntries ?? 0,
  });

  it('молчит, когда в цепочке есть кого показывать', () => {
    expect(chainAbsence(report([2, 0, 1]))).toBeNull();
  });

  it('называет период, в который никого не двигали', () => {
    // Ни одной записи за период: цепочка приходит пустым списком.
    expect(chainAbsence(report([]))).toBe('nothing-moved');
    // Стадии есть, входов нет — то же самое.
    expect(chainAbsence(report([0, 0]))).toBe('nothing-moved');
  });

  it('отличает переходы мимо цепочки от их отсутствия', () => {
    // Двенадцать переходов в «Отказ» — цепочка пуста, но лидов двигали, и фраза «лидов по
    // воронке не двигали» стояла бы прямо над плиткой «Отказов: 12».
    expect(chainAbsence(report([0, 0], { failureEntries: 12 }))).toBe('off-chain');
    // То же самое для стадии, которую с тех пор удалили: колонки у неё нет, переход был.
    expect(chainAbsence(report([0], { deletedStageEntries: 3 }))).toBe('off-chain');
  });
});
