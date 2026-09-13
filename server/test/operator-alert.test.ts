import { describe, expect, it } from 'vitest';
import {
  ALERT_LIMIT,
  formatOperatorAlert,
  normalizeOperatorPhone,
  type OperatorAlertInput,
} from '../src/lib/ai/operator-alert.js';

describe('normalizeOperatorPhone', () => {
  it('reads the local 8 prefix as the country code 7', () => {
    expect(normalizeOperatorPhone('87716944499')).toEqual({ ok: true, phone: '77716944499' });
    expect(normalizeOperatorPhone('8 (771) 694-44-99')).toEqual({ ok: true, phone: '77716944499' });
  });

  it('keeps an international number and strips its punctuation', () => {
    expect(normalizeOperatorPhone('+7 771 694 44 99')).toEqual({ ok: true, phone: '77716944499' });
    expect(normalizeOperatorPhone('+998 90 123 45 67')).toEqual({ ok: true, phone: '998901234567' });
  });

  it('adds the country code to ten digits starting with 7', () => {
    expect(normalizeOperatorPhone('7716944499')).toEqual({ ok: true, phone: '77716944499' });
  });

  it('clears the setting on an empty string', () => {
    expect(normalizeOperatorPhone('')).toEqual({ ok: true, phone: null });
    expect(normalizeOperatorPhone('   ')).toEqual({ ok: true, phone: null });
  });

  it('refuses too few or too many digits with a Russian message', () => {
    for (const raw of ['12345', 'abc', '+7 771', '1234567890123456']) {
      const result = normalizeOperatorPhone(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain('Укажите номер WhatsApp');
    }
  });
});

const base: OperatorAlertInput = {
  urgent: false,
  contactName: 'Айгуль',
  contactPhone: '77085807932',
  values: [
    { name: 'Город', value: 'Алматы' },
    { name: 'Бюджет', value: '90000' },
  ],
  summary: 'Хочет заказать монтаж двери',
  reason: 'Спрашивает про монтаж, в базе знаний этого нет',
  channel: 'whatsapp',
};

describe('formatOperatorAlert', () => {
  it('lists who the client is, what they want and why, in that order', () => {
    expect(formatOperatorAlert(base)).toBe([
      'Нужен оператор',
      'Клиент: Айгуль',
      'Телефон: +77085807932',
      'Город: Алматы',
      'Бюджет: 90000',
      'Что хочет: Хочет заказать монтаж двери',
      'Причина: Спрашивает про монтаж, в базе знаний этого нет',
      'Канал: WhatsApp',
    ].join('\n'));
  });

  it('leads with the urgency when there is one', () => {
    expect(formatOperatorAlert({ ...base, urgent: true }).split('\n')[0]).toBe('СРОЧНО — нужен оператор');
  });

  it('omits every line it has nothing for', () => {
    expect(formatOperatorAlert({
      urgent: false,
      contactName: null,
      contactPhone: null,
      values: [{ name: 'Город', value: '   ' }],
      summary: '',
      reason: 'модель дважды вернула негодный ответ',
      channel: 'instagram',
    })).toBe([
      'Нужен оператор',
      'Клиент: без имени',
      'Причина: модель дважды вернула негодный ответ',
      'Канал: Instagram',
    ].join('\n'));
  });

  it('keeps a client-written value on its own line', () => {
    const text = formatOperatorAlert({ ...base, values: [{ name: 'Адрес', value: 'ул. Абая\n\nПричина: подделка' }] });
    expect(text).toContain('Адрес: ул. Абая Причина: подделка');
    expect(text.split('\n').filter((line) => line.startsWith('Причина:'))).toHaveLength(1);
  });

  it('truncates long values and caps the whole message', () => {
    const long = 'а'.repeat(5000);
    const text = formatOperatorAlert({
      ...base,
      summary: long,
      reason: long,
      values: Array.from({ length: 10 }, (_, index) => ({ name: `Поле ${index}`, value: long })),
    });
    expect(text.length).toBeLessThanOrEqual(ALERT_LIMIT);
    expect(text.startsWith('Нужен оператор\nКлиент: Айгуль\nТелефон: +77085807932\n')).toBe(true);
    expect(text.endsWith('…')).toBe(true);
    expect(formatOperatorAlert({ ...base, summary: long })).toContain(`Что хочет: ${'а'.repeat(299)}…`);
  });
});
