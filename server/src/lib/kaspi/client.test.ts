import { describe, expect, it, vi } from 'vitest';
import { KaspiClient, normalisePhone, paymentOutcome } from './client.js';
describe('Kaspi provider contract', () => {
  it('normalises Kazakhstan phone numbers and rejects foreign numbers', () => {
    expect(normalisePhone('+7 (701) 123-45-67')).toBe('77011234567');
    expect(normalisePhone('7011234567')).toBe('77011234567');
    expect(() => normalisePhone('15551234567')).toThrow();
  });
  it('accepts only Processed and checks the exact amount', () => {
    expect(paymentOutcome({ StatusCode: 0, Data: { Status: 'Processed', Amount: '1200.00' } }, '1200')).toBe('paid');
    expect(() => paymentOutcome({ StatusCode: 0, Data: { Status: 'Processed', Amount: '1200.99' } }, '1200')).toThrow();
    expect(paymentOutcome({ StatusCode: 0, Data: { Status: 'RemotePaymentCreated' } }, '1200')).toBe('pending');
    expect(paymentOutcome({ StatusCode: 0, Data: { Status: 'Success' } }, '1200')).toBe('pending');
  });
  it('uses invoice family with eleven digits and does not retry a failed create', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('timeout'));
    const client = new KaspiClient('http://localhost:3001', fetcher);
    await expect(client.create('invoice', { tokenSN: 'x', vtokenSecret: 'y' }, '100', '7011234567', 'Order')).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe('http://localhost:3001/api/invoice/create');
    expect(JSON.parse(fetcher.mock.calls[0]?.[1].body).phoneNumber).toBe('77011234567');
  });
});
