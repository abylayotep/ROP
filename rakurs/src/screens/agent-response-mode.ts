import type { AgentResponseMode, AiTestContact } from '@/types';
import { formatPhone } from '@/lib/phone';

export interface ResponseModeDraft {
  responseMode: AgentResponseMode;
  testContactId: string | null;
}

export type ResponseModeSaveDecision =
  | { kind: 'blocked'; reason: 'test_contact_required' }
  | { kind: 'confirm_live' }
  | {
      kind: 'save';
      body: { responseMode: AgentResponseMode; testContactId: string | null };
    };

export function initialResponseModeDraft(settings: {
  responseMode: AgentResponseMode;
  testContact: AiTestContact | null;
}): ResponseModeDraft {
  return {
    responseMode: settings.responseMode,
    testContactId: settings.testContact?.id ?? null,
  };
}

export function changeResponseMode(
  draft: ResponseModeDraft,
  responseMode: AgentResponseMode,
): ResponseModeDraft {
  return { ...draft, responseMode };
}

export function responseModeDraftDirty(
  draft: ResponseModeDraft,
  settings: { responseMode: AgentResponseMode; testContact: AiTestContact | null },
): boolean {
  return (
    draft.responseMode !== settings.responseMode
    || draft.testContactId !== (settings.testContact?.id ?? null)
  );
}

export function persistedResponseModeWarning(settings: {
  responseMode: AgentResponseMode;
  testContact: AiTestContact | null;
}): string | null {
  return settings.responseMode === 'test' && settings.testContact === null
    ? 'Тестовый клиент больше недоступен. Выберите другого клиента и сохраните режим.'
    : null;
}

export function responseModeSaveDecision(
  draft: ResponseModeDraft,
  liveConfirmed: boolean,
): ResponseModeSaveDecision {
  if (draft.responseMode === 'test' && !draft.testContactId) {
    return { kind: 'blocked', reason: 'test_contact_required' };
  }
  if (draft.responseMode === 'live' && !liveConfirmed) {
    return { kind: 'confirm_live' };
  }
  return {
    kind: 'save',
    body: {
      responseMode: draft.responseMode,
      testContactId: draft.testContactId,
    },
  };
}

export function testContactLabel(contact: AiTestContact): string {
  const phone = formatPhone(contact.phone);
  return contact.name ? `${contact.name} · ${phone}` : phone;
}
