import type { proto } from '@whiskeysockets/baileys';
import { describe, expect, it } from 'vitest';
import { normalize } from '../src/lib/whatsapp/linked/normalize.js';

function line(contextInfo: proto.IContextInfo) {
  return normalize({ key: { id: 'message', remoteJid: '77010000001@s.whatsapp.net' },
    message: { extendedTextMessage: { text: 'Hello', contextInfo } } });
}

describe('linked attribution normalization', () => {
  it('reads the installed Baileys external ad schema without inventing identifiers', () => {
    expect(line({ externalAdReply: { sourceId: '123', sourceType: 'ad', title: 'Offer',
      body: 'Description', ctwaClid: 'actual-click' } })).toMatchObject({ referral: {
      source_id: '123', source_type: 'ad', headline: 'Offer', body: 'Description', ctwa_clid: 'actual-click',
    } });
  });
  it('keeps known ad metadata without manufacturing a click id', () => {
    expect(line({ externalAdReply: { sourceId: '123', title: 'Offer' } })?.referral)
      .toMatchObject({ source_id: '123', headline: 'Offer' });
    expect(line({ externalAdReply: { sourceId: '123' } })?.referral?.ctwa_clid).toBeUndefined();
  });
  it('ignores empty contexts and ordinary link previews', () => {
    expect(line({})?.referral).toBeUndefined();
    expect(line({ externalAdReply: {} })?.referral).toBeUndefined();
    expect(line({ externalAdReply: { title: 'Website', sourceUrl: 'https://example.com/?ad_id=123' } })?.referral)
      .toBeUndefined();
  });
});
