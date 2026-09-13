import { describe, expect, it } from 'vitest';
import { whatsappQrPairingEnabled } from './features';

describe('whatsappQrPairingEnabled', () => {
  it('is off when the build does not set the flag', () => {
    expect(whatsappQrPairingEnabled({})).toBe(false);
  });

  it.each(['false', '1', 'TRUE', 'yes', ''])('stays off for %j', (value) => {
    expect(whatsappQrPairingEnabled({ VITE_WHATSAPP_QR_ENABLED: value })).toBe(false);
  });

  it('turns on only for the exact string "true"', () => {
    expect(whatsappQrPairingEnabled({ VITE_WHATSAPP_QR_ENABLED: 'true' })).toBe(true);
  });
});
