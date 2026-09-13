export type CorrectionTarget =
  | { kind: 'live'; conversationId: string; replyId: string }
  | { kind: 'sandbox'; sessionId: string; turnId: string };

export function correctionSource(target: CorrectionTarget) {
  return target.kind === 'live'
    ? { kind: 'conversation_reply' as const, conversationId: target.conversationId, aiReplyId: target.replyId }
    : { kind: 'sandbox_turn' as const, sessionId: target.sessionId, turnId: target.turnId };
}

export function correctionText(note: string): string | null {
  return note.trim() || null;
}

export function findCompletedFeedback<T extends { role: string; feedbackId?: string | null; text: string }>(
  messages: T[], existing: Set<string>, note: string,
): T | null {
  const owner = messages.find((item) => item.role === 'owner' && item.feedbackId &&
    !existing.has(item.feedbackId) && item.text === note);
  return messages.find((item) => item.role === 'model' && item.feedbackId === owner?.feedbackId) ?? null;
}

export function recoveredTurn<T extends { revision: number; userText: string }>(
  session: { revision: number; turns: T[] }, pending: { revision: number; text: string },
): T | null {
  if (session.revision <= pending.revision) return null;
  return session.turns.find((turn) => turn.revision === pending.revision + 1 && turn.userText === pending.text) ?? null;
}
