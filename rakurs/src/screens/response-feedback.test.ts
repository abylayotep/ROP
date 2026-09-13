import { describe, expect, it } from 'vitest';
import { correctionSource, correctionText, recoveredTurn, findCompletedFeedback, readPendingCorrection, savePendingCorrection } from './response-feedback';

describe('response correction', () => {
  it('binds live feedback to the selected reply, not the latest conversation reply', () => {
    expect(correctionSource({ kind: 'live', conversationId: 'dialog-1', replyId: 'reply-2' })).toEqual({
      kind: 'conversation_reply', conversationId: 'dialog-1', aiReplyId: 'reply-2',
    });
  });

  it('binds sandbox feedback to the selected turn', () => {
    expect(correctionSource({ kind: 'sandbox', sessionId: 'session-1', turnId: 'turn-2' })).toEqual({
      kind: 'sandbox_turn', sessionId: 'session-1', turnId: 'turn-2',
    });
  });

  it('requires a substantive operator note', () => {
    expect(correctionText('  ')).toBeNull();
    expect(correctionText('  Уточнить сроки  ')).toBe('Уточнить сроки');
  });

  it('recovers a persisted turn after an ambiguous send timeout without resending', () => {
    expect(recoveredTurn({ revision: 2, turns: [{ revision: 2, userText: 'Есть доставка?', id: 'turn-2' }] },
      { revision: 1, text: 'Есть доставка?' })).toEqual({ revision: 2, userText: 'Есть доставка?', id: 'turn-2' });
    expect(recoveredTurn({ revision: 1, turns: [] }, { revision: 1, text: 'Есть доставка?' })).toBeNull();
  });

  it('does not mistake an in-flight owner row or an older proposal for completed feedback', () => {
    const messages = [
      { role: 'model', feedbackId: 'previous', text: 'Old proposal' },
      { role: 'owner', feedbackId: 'new', text: 'Correct the reply' },
    ];
    expect(findCompletedFeedback(messages, new Set(['previous']), 'Correct the reply')).toBeNull();
    expect(findCompletedFeedback([...messages, { role: 'model', feedbackId: 'new', text: 'New proposal' }],
      new Set(['previous']), 'Correct the reply')).toEqual({ role: 'model', feedbackId: 'new', text: 'New proposal' });
  });

  it('restores the same in-flight request key and note after a page reload', () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
    savePendingCorrection(storage, 'agent-1', {
      requestKey: '11111111-1111-4111-8111-111111111111',
      target: { kind: 'sandbox', sessionId: 'session-1', turnId: 'turn-1' },
      note: 'Answer in three days', correctionType: 'fact',
    });
    expect(readPendingCorrection(storage, 'agent-1')).toEqual({
      requestKey: '11111111-1111-4111-8111-111111111111',
      target: { kind: 'sandbox', sessionId: 'session-1', turnId: 'turn-1' },
      note: 'Answer in three days', correctionType: 'fact',
    });
  });
});
