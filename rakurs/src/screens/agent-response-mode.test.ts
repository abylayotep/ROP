import { describe, expect, it } from 'vitest';
import type { AiTestContact } from '@/types';
import {
  changeResponseMode,
  initialResponseModeDraft,
  responseModeSaveDecision,
  testContactLabel,
} from './agent-response-mode';

const contact: AiTestContact = {
  id: '3c429999-170b-4c05-b16b-66ce524432ef',
  name: 'Айгуль',
  phone: '77001234567',
};

describe('agent response mode form state', () => {
  it('retains the test contact while switching away from test mode', () => {
    const initial = initialResponseModeDraft({ responseMode: 'test', testContact: contact });

    const off = changeResponseMode(initial, 'off');
    const live = changeResponseMode(off, 'live');

    expect(off.testContactId).toBe(contact.id);
    expect(live.testContactId).toBe(contact.id);
  });

  it('blocks saving test mode until one contact is selected', () => {
    const draft = initialResponseModeDraft({ responseMode: 'off', testContact: null });

    expect(responseModeSaveDecision(changeResponseMode(draft, 'test'), false)).toEqual({
      kind: 'blocked',
      reason: 'test_contact_required',
    });
  });

  it('requires an explicit confirmation before saving live mode', () => {
    const draft = changeResponseMode(
      initialResponseModeDraft({ responseMode: 'test', testContact: contact }),
      'live',
    );

    expect(responseModeSaveDecision(draft, false)).toEqual({ kind: 'confirm_live' });
    expect(responseModeSaveDecision(draft, true)).toEqual({
      kind: 'save',
      body: { responseMode: 'live', testContactId: contact.id },
    });
  });

  it('shows the selected contact name with a normalized phone number', () => {
    expect(testContactLabel(contact)).toBe('Айгуль · +7 700 123 45 67');
    expect(testContactLabel({ ...contact, name: null })).toBe('+7 700 123 45 67');
  });
});
