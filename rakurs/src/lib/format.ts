/** Форматирование чисел и склонения. Всё, что видит пользователь, — по-русски. */

/**
 * Русское склонение по числу: plural(5, 'диалог', 'диалога', 'диалогов') → 'диалогов'.
 */
export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

/** Разряды через неразрывный пробел, как в ru-RU. */
export function num(n: number): string {
  return n.toLocaleString('ru-RU');
}

/**
 * Давность данных словами: freshness(12) → 'обновлено 12 минут назад'.
 *
 * Считается от Profile.updatedMinutesAgo — единственного источника свежести.
 * Раньше экраны писали «обновлено 12 минут назад» жёстко в строке, и подпись
 * врала тем убедительнее, чем дольше не обновлялись данные.
 */
export function freshness(minutes: number): string {
  if (minutes < 1) return 'обновлено только что';
  if (minutes < 60) return `обновлено ${minutes} ${plural(minutes, 'минуту', 'минуты', 'минут')} назад`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `обновлено ${hours} ${plural(hours, 'час', 'часа', 'часов')} назад`;

  const days = Math.floor(hours / 24);
  return `обновлено ${days} ${plural(days, 'день', 'дня', 'дней')} назад`;
}

export function money(n: number, currency: string): string {
  return `${num(n)} ${currency}`;
}

/** 47 900 000 → «47,9 млн». Десятичная запятая, как принято в русской типографике. */
export function mln(n: number): string {
  return `${(n / 1_000_000).toFixed(1).replace('.', ',')} млн`;
}

/** 19 200 000 → «19,20 млн» — два знака, для строк с точным чеком. */
export function mln2(n: number): string {
  return `${(n / 1_000_000).toFixed(2).replace('.', ',')} млн`;
}

/** Десятичная точка → запятая, для процентов и ROAS внутри предложений. */
export function comma(s: string | number): string {
  return String(s).replace('.', ',');
}

export function pct(part: number, whole: number, digits = 0): string {
  if (!whole) return '0%';
  const v = (part / whole) * 100;
  return `${digits ? comma(v.toFixed(digits)) : Math.round(v)}%`;
}
