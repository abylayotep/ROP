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

export function recoveredTurn<T extends { revision: number; userText: string }>(
  session: { revision: number; turns: T[] }, pending: { revision: number; text: string },
): T | null {
  if (session.revision <= pending.revision) return null;
  return session.turns.find((turn) => turn.revision === pending.revision + 1 && turn.userText === pending.text) ?? null;
}
