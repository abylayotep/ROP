import { describe, expect, it } from 'vitest';
import { correctionSource, correctionText, recoveredTurn, findCompletedFeedback } from './response-feedback';

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
});
