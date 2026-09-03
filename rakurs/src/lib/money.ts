/**
 * Amounts arrive from the server as a string: `numeric` never passes through a
 * float at any step, because 1234567.89 as a double is no longer 1234567.89.
 *
 * We format the string, not the number: split into the whole and fractional
 * parts on the dot and insert thin spaces between digit groups. We show the
 * fractional part only when it is non-zero — tenge never has one, and
 * «450 000,00 ₸» in a list reads worse than «450 000 ₸».
 */

/**
 * The spaces are written as escape sequences rather than the characters
 * themselves: a regular, thin, and non-breaking space are indistinguishable
 * to the eye in source code, and one careless formatter pass silently turns
 * them into ASCII, breaking nothing at the type level.
 *
 * Narrow no-break space (U+202F) — between digit groups. It has to be both: an
 * ordinary space there reads as the end of the number, and a plain thin space
 * (U+2009) permits a line break, which is how «450 000,50 ₸» came out as «450»
 * with «000,50 ₸» underneath it in the lead panel. Non-breaking space (U+00A0)
 * — before the currency sign, for the same reason one column over.
 */
const GROUP_SPACE = '\u202f';
const NO_BREAK_SPACE = '\u00a0';

const SYMBOLS: Record<string, string> = { KZT: '₸', RUB: '₽', USD: '$', EUR: '€', UZS: 'сўм' };

export function formatMoney(amount: string, currency: string): string {
  const [whole = '0', cents = '00'] = amount.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, GROUP_SPACE);
  const tail = cents === '00' ? '' : `,${cents}`;
  return `${grouped}${tail}${NO_BREAK_SPACE}${SYMBOLS[currency] ?? currency}`;
}
