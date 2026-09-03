/**
 * Two decisions of the «Движение по воронке» card, lifted out of the markup.
 *
 * Both are about what is printed being true rather than about how it looks: how to show a
 * share that rounds down to zero, and what to say when the chain is empty but leads did
 * move during the period. They are pure functions here because they need checking one case
 * at a time, not by eye against a screen.
 */
import type { FunnelStep, StatsPeriodReport } from '@/types';

/**
 * Written as an escape rather than the character itself, for the reason in `lib/money.ts`:
 * a non-breaking space in source is indistinguishable from an ordinary one, and a single
 * careless formatter run turns «12 %» into a string that can break between the number and
 * the sign.
 */
const NO_BREAK_SPACE = '\u00a0';

/**
 * A share in whole percent — except the one below a single percent.
 *
 * In numbers rather than strings, and that is not an oversight: a conversion is a ratio of
 * two counters, not money. Rounding it to a whole number is allowed; rounding a sum is not.
 *
 * One lead in two hundred and fifty is 0.4%, and `Math.round` printed «0 %» underneath it.
 * That is exactly what the card reserves for «there is no share at all»: a zero there is an
 * accusation, not a number. So anything below a percent shows as «<1 %» — the share exists,
 * it is merely small.
 */
export function percent(share: number): string {
  const whole = Math.round(share * 100);
  if (whole === 0) return `<1${NO_BREAK_SPACE}%`;
  return `${whole}${NO_BREAK_SPACE}%`;
}

/**
 * Why there is nothing to draw in the chain — and whether there is such a reason at all.
 *
 * - `null` — draw the chain; leads entered some stage during the period.
 * - `'nothing-moved'` — nobody was moved anywhere during the period.
 * - `'off-chain'` — leads were moved, but only where the chain does not reach: into a
 *   failure stage, or into a stage deleted since.
 *
 * The third case is the reason this is a function rather than an `every()` in the markup.
 * An empty chain and the sentence «лидов по воронке не двигали» under it used to sit beside
 * the tile «Отказов: 12» — twelve moves we had just said did not happen.
 */
export type ChainAbsence = 'nothing-moved' | 'off-chain' | null;

export function chainAbsence(
  report: Pick<StatsPeriodReport, 'failureEntries' | 'deletedStageEntries'> & {
    funnel: Pick<FunnelStep, 'entered'>[];
  },
): ChainAbsence {
  if (report.funnel.some((step) => step.entered > 0)) return null;
  return report.failureEntries > 0 || report.deletedStageEntries > 0
    ? 'off-chain'
    : 'nothing-moved';
}
