/**
 * «Сутки», «Неделя» и «Месяц» — три кнопки периода, написанные один раз.
 *
 * The AI usage card asked for them first and the statistics screen offers the same three.
 * A second copy of the list is a second thing to keep in step with
 * `server/src/lib/period.ts`, which is the only place that turns one of them into a date —
 * so both screens read this one and neither keeps a spelling of its own.
 *
 * `plainly` is the answer the owner is actually after: «за последние 7 дней» is a sentence,
 * where «7» in the corner of a card is a riddle.
 */
import type { Period } from '@/types';

export const PERIODS: { id: Period; label: string; plainly: string }[] = [
  { id: 'day', label: 'Сутки', plainly: 'За последние сутки' },
  { id: 'week', label: 'Неделя', plainly: 'За последние 7 дней' },
  { id: 'month', label: 'Месяц', plainly: 'За последние 30 дней' },
];
