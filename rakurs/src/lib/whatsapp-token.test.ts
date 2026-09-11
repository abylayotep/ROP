/**
 * Срок жизни токена Meta: за сколько дней предупредить и что сказать, когда уже поздно.
 *
 * The configuration production runs on issues a token that dies after sixty days. Nobody
 * is watching a date in a database, so the only warning an owner will ever get is the one
 * the cabinet prints — and it has to arrive while there is still time to act, name the
 * number, and say the one thing that fixes it.
 */
import { describe, expect, it } from 'vitest';
import type { WhatsappNumber } from '@/types';
import { RENEW_ACTION, tokenDeadline, numbersToRenew } from './whatsapp-token';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-09-11T09:00:00.000Z');
const inDays = (days: number) => new Date(NOW.getTime() + days * DAY).toISOString();

const number = (over: Partial<WhatsappNumber> = {}): WhatsappNumber => ({
  id: 'n1',
  phoneNumberId: '100',
  wabaId: '200',
  displayPhone: '+7 700 000 00 00',
  enabled: true,
  subscribed: true,
  connectedAt: '2026-09-01T10:00:00.000Z',
  connectionKind: 'coexistence',
  linkedState: null,
  historyProgress: 100,
  historyDeclined: false,
  syncError: null,
  offboarded: false,
  tokenExpiresAt: null,
  ...over,
});

describe('tokenDeadline', () => {
  it('говорит «нечего показывать», когда срока нет', () => {
    // Пустое поле — это «срок неизвестен», а не «истёк». Вручную вставленный токен
    // системного пользователя вполне может быть вечным.
    expect(tokenDeadline(number(), NOW).state).toBe('none');
  });

  it('не выдумывает срок номеру, подключённому по QR', () => {
    // У связанного устройства токена Meta нет вообще: там сессия и QR-код.
    expect(tokenDeadline(number({ connectionKind: 'linked', tokenExpiresAt: inDays(3) }), NOW).state)
      .toBe('none');
  });

  it('молчит, пока до конца далеко', () => {
    expect(tokenDeadline(number({ tokenExpiresAt: inDays(45) }), NOW)).toMatchObject({
      state: 'ok',
      daysLeft: 45,
    });
  });

  it('предупреждает за две недели — этого хватает, чтобы дойти до кабинета', () => {
    const deadline = tokenDeadline(number({ tokenExpiresAt: inDays(14) }), NOW);

    expect(deadline.state).toBe('soon');
    expect(deadline.note).toContain('14 дней');
    expect(deadline.note).toContain(RENEW_ACTION);
  });

  it('склоняет дни по-русски', () => {
    expect(tokenDeadline(number({ tokenExpiresAt: inDays(1) }), NOW).note).toContain('1 день');
    expect(tokenDeadline(number({ tokenExpiresAt: inDays(3) }), NOW).note).toContain('3 дня');
    expect(tokenDeadline(number({ tokenExpiresAt: inDays(11) }), NOW).note).toContain('11 дней');
  });

  it('называет сегодняшний последний день последним днём, а не нулём дней', () => {
    const deadline = tokenDeadline(number({ tokenExpiresAt: inDays(0.4) }), NOW);

    expect(deadline.state).toBe('soon');
    expect(deadline.note).toContain('сегодня');
  });

  it('говорит прямо, что номер уже не работает', () => {
    const deadline = tokenDeadline(number({ tokenExpiresAt: inDays(-1) }), NOW);

    expect(deadline.state).toBe('expired');
    expect(deadline.daysLeft).toBe(0);
    // Ни «возможно», ни «скоро»: с этой минуты не уходит и не приходит ничего.
    expect(deadline.note).toContain('не отправляет и не принимает сообщения');
    expect(deadline.note).toContain(RENEW_ACTION);
  });

  it('считает истёкшим момент ровно на границе', () => {
    expect(tokenDeadline(number({ tokenExpiresAt: NOW.toISOString() }), NOW).state).toBe('expired');
  });
});

describe('numbersToRenew', () => {
  it('не поднимает шум, когда всё в порядке', () => {
    expect(numbersToRenew([number({ tokenExpiresAt: inDays(45) }), number()], NOW)).toEqual([]);
  });

  it('собирает номера, которым нужен новый токен, истёкшие первыми', () => {
    const ok = number({ id: 'ok', tokenExpiresAt: inDays(45) });
    const soon = number({ id: 'soon', tokenExpiresAt: inDays(10) });
    const dead = number({ id: 'dead', tokenExpiresAt: inDays(-2) });

    // Порядок — это порядок срочности: сначала тот, который уже не работает.
    expect(numbersToRenew([ok, soon, dead], NOW).map((entry) => entry.number.id)).toEqual([
      'dead',
      'soon',
    ]);
  });
});
