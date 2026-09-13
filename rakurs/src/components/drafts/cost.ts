/**
 * The sentence shown above the run button — how many model calls a run of the checked cases
 * would actually make, before a single one is spent.
 *
 * A case always pays for «стало»: the draft's own ops, applied, is the whole point of asking.
 * «Было» is free exactly when a usable baseline already exists — see `api/drafts.ts`'s own
 * comment on `baselineResults` for what "usable" means server-side. This function cannot know
 * that for certain ahead of the click (there is no route that answers "does a baseline exist"
 * without running one), so the caller hands in its own best guess — ordinarily the case ids
 * that carried a `before` in the draft's most recent run, which is exactly what would still be
 * true unless the store moved under it since. Getting this wrong costs nothing: it only
 * changes what the sentence *says*, never what the run itself actually spends.
 *
 * The one annotation call («сравнение») is billed once per case regardless of caching, since
 * it compares the two replies rather than reusing either.
 */
import type { TestCase } from '@/types';

/** Russian has three plural forms, not two — «1 проверка», «2 проверки», «5 проверок» — and
 * the branch a count falls into depends on its last two digits, not merely its last one:
 * eleven through nineteen all take the "many" form despite ending in a digit that otherwise
 * would not. Exported so every other "N of something" caption in the drafts screens — a case's
 * own message count in `CaseList.tsx`, say — declines the same way instead of reinventing (or
 * skipping) the three-form rule for itself. */
export function ruPlural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

/** OpenRouter dollars, printed from the string Postgres summed. Four decimals below one dollar:
 * a cheap model spends fractions of a cent, and two would print «0,00 $» where there was spend. */
export function money(cost: string): string {
  const value = Number(cost);
  if (!Number.isFinite(value)) return `${cost} $`;
  const digits = value !== 0 && value < 1 ? 4 : 2;
  return `${value.toFixed(digits).replace('.', ',')} $`;
}

const casesWord = (n: number) => ruPlural(n, 'проверка', 'проверки', 'проверок');
const callsWord = (n: number) => ruPlural(n, 'вызов', 'вызова', 'вызовов');
const comparisonsWord = (n: number) => ruPlural(n, 'сравнение', 'сравнения', 'сравнений');

export function describeRun(cases: TestCase[], baselines: Set<string>): string {
  // A case can stay ticked in `selected` while its own toggle turns it off — the run route
  // filters a disabled case out before spending anything on it (`api/drafts.ts`), and this
  // caption has to price the same set the server actually runs, not merely the set the owner
  // happened to have checked.
  const runnable = cases.filter((c) => c.enabled);
  const n = runnable.length;
  const reused = runnable.filter((c) => baselines.has(c.id)).length;

  // «Стало» every case, «было» only for the ones with no baseline to reuse.
  const calls = 2 * n - reused;

  // Said only when *every* checked case is covered — a partial reuse still changes the count
  // above, but naming it is only worth a reader's attention once nothing at all is being paid
  // for a second time.
  const note = n > 0 && reused === n ? ' (прежние ответы взяты из прошлого прогона)' : '';

  return (
    `${n} ${casesWord(n)}: ${calls} ${callsWord(calls)} модели${note}` +
    ` плюс ${n} ${comparisonsWord(n)}`
  );
}
