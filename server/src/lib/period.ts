/**
 * What «Сутки», «Неделя» and «Месяц» mean, in one place.
 *
 * The AI usage endpoint decided this first — rolling windows of 1, 7 and 30 days, a
 * `?period=` query and 400 «Неизвестный период» for anything else — and the statistics
 * screen offers the same three buttons. A second definition of the same three buttons is a
 * second thing to keep in step, so both routes read this module and neither keeps a copy.
 */
import type { Period } from '@rakurs/contract';
import { z } from 'zod';

/**
 * How far back each period looks. A month is thirty days, not a calendar one.
 *
 * The owner is asking «во сколько мне обходится эта модель», not «сколько я потратил в
 * августе»: a rolling window answers that on the third of the month as well as on the
 * thirtieth, where a calendar month would show two days of turns and look like a bargain.
 */
export const PERIOD_DAYS: Record<Period, number> = { day: 1, week: 7, month: 30 };

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The `?period=` query, as every route that takes one parses it.
 *
 * Optional, because a caller that names no period gets the default the route picks — `week`
 * everywhere so far. Anything outside the three is a parse failure, which the route answers
 * as 400 «Неизвестный период» rather than quietly falling back to a window nobody asked for.
 */
export const periodQuery = z.object({ period: z.enum(['day', 'week', 'month']).optional() });

/**
 * The instant a period starts, counted back from now.
 *
 * Computed on the server and answered back to the screen, so the screen names the same
 * instant the numbers were counted from instead of guessing at one from its own clock.
 */
export const periodSince = (period: Period): Date =>
  new Date(Date.now() - PERIOD_DAYS[period] * DAY_MS);
