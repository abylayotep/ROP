/**
 * Сколько осталось жить токену Meta и что об этом сказать владельцу.
 *
 * The Embedded Signup configuration this product runs on is built from Meta's «WhatsApp
 * Embedded Signup with 60-day token» template: every token it issues dies sixty days after
 * it was made. There is no refresh call and no permanent token to switch to — that needs
 * Tech Provider status, which the application does not have. The only cure is running the
 * same signup window again, and the only thing standing between an owner and a silent
 * number is this warning.
 *
 * Kept out of the screen and tested on its own for the usual reason: the decision of when
 * to shout is the part that can be wrong, and JSX is a bad place to argue with it.
 */
import type { WhatsappNumber } from '@/types';

const DAY = 24 * 60 * 60 * 1000;

/**
 * За сколько дней до конца начинать предупреждать.
 *
 * Two weeks out of sixty. Short enough that the warning is not background noise for a
 * month and a half, long enough to survive a holiday, an owner who checks the cabinet
 * once a week, and the day it takes to find whoever has the Meta password.
 */
export const WARN_DAYS = 14;

/** Одна фраза на оба состояния: действие всегда одно и то же. */
export const RENEW_ACTION = 'Подключите номер заново через Meta.';

export type TokenState = 'none' | 'ok' | 'soon' | 'expired';

export interface TokenDeadline {
  state: TokenState;
  /** Полных дней до конца; 0 для истёкшего и null, когда срок неизвестен. */
  daysLeft: number | null;
  /** Строка для карточки номера. Пустая, когда показывать нечего. */
  note: string;
}

/** «1 день», «3 дня», «11 дней» — обычные русские правила, включая 11–14. */
function days(count: number): string {
  const hundred = count % 100;
  const ten = count % 10;
  if (hundred >= 11 && hundred <= 14) return `${count} дней`;
  if (ten === 1) return `${count} день`;
  if (ten >= 2 && ten <= 4) return `${count} дня`;
  return `${count} дней`;
}

/**
 * Состояние токена одного номера.
 *
 * `none` — не «всё хорошо», а «сказать нечего»: у номера по QR токена Meta нет вовсе, а
 * пустое поле означает неизвестный срок, и пугать им владельца не за что.
 */
export function tokenDeadline(number: WhatsappNumber, now: Date = new Date()): TokenDeadline {
  if (number.connectionKind === 'linked' || number.tokenExpiresAt === null) {
    return { state: 'none', daysLeft: null, note: '' };
  }

  const left = new Date(number.tokenExpiresAt).getTime() - now.getTime();
  if (left <= 0) {
    return {
      state: 'expired',
      daysLeft: 0,
      note: `Доступ Meta истёк: номер не отправляет и не принимает сообщения. ${RENEW_ACTION}`,
    };
  }

  // Вниз, а не к ближайшему: «остался 1 день» за двадцать пять часов до конца — это
  // правда, а «2 дня» — обещание, которого никто не давал.
  const daysLeft = Math.floor(left / DAY);
  if (daysLeft > WARN_DAYS) return { state: 'ok', daysLeft, note: '' };

  return {
    state: 'soon',
    daysLeft,
    note:
      daysLeft === 0
        ? `Доступ Meta истекает сегодня. ${RENEW_ACTION}`
        : `Доступ Meta истекает через ${days(daysLeft)}. ${RENEW_ACTION}`,
  };
}

export interface NumberToRenew {
  number: WhatsappNumber;
  deadline: TokenDeadline;
}

/**
 * Номера, которым нужен новый токен, — самые срочные первыми.
 *
 * Возвращает пустой массив, когда всё в порядке, чтобы экран мог просто спросить
 * `length === 0` и не рисовать баннер.
 */
export function numbersToRenew(
  numbers: WhatsappNumber[],
  now: Date = new Date(),
): NumberToRenew[] {
  return numbers
    .map((number) => ({ number, deadline: tokenDeadline(number, now) }))
    .filter((entry) => entry.deadline.state === 'expired' || entry.deadline.state === 'soon')
    .sort((a, b) => (a.deadline.daysLeft ?? 0) - (b.deadline.daysLeft ?? 0));
}
