import { describe, expect, it } from 'vitest';
import { formatPhone, phoneDigits } from './phone';

describe('phone presentation', () => {
  it.each([
    ['77777777777', '+7 777 777 77 77'],
    ['+7 (777) 777-77-77', '+7 777 777 77 77'],
    ['87777777777', '+7 777 777 77 77'],
  ])('formats a Kazakhstan phone number from %s', (phone, expected) => {
    expect(formatPhone(phone)).toBe(expected);
  });

  it('keeps an unknown phone value visible instead of inventing digits', () => {
    expect(formatPhone('whatsapp-user')).toBe('whatsapp-user');
    expect(formatPhone('')).toBe('Номер не указан');
  });

  it('normalizes formatted phone input for search', () => {
    expect(phoneDigits('+7 777 777 77 77')).toBe('77777777777');
    expect(phoneDigits('8 (777) 777-77-77')).toBe('77777777777');
  });
});
