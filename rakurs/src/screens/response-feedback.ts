export type CorrectionTarget =
  | { kind: 'live'; conversationId: string; replyId: string }
  | { kind: 'sandbox'; sessionId: string; turnId: string };

export interface PendingCorrection {
  requestKey: string;
  target: CorrectionTarget;
  note: string;
  correctionType: 'fact' | 'behavior';
}

type CorrectionStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export const pendingCorrectionKey = (agentId: string) => `rakurs:pending-correction:${agentId}`;

export function savePendingCorrection(storage: CorrectionStorage, agentId: string, value: PendingCorrection): void {
  storage.setItem(pendingCorrectionKey(agentId), JSON.stringify(value));
}

export function readPendingCorrection(storage: CorrectionStorage, agentId: string): PendingCorrection | null {
  try {
    const raw = storage.getItem(pendingCorrectionKey(agentId));
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || !value) return null;
    const item = value as Partial<PendingCorrection>;
    if (!item.requestKey || !item.target || !item.note || !['fact', 'behavior'].includes(item.correctionType ?? '')) return null;
    if (item.target.kind === 'live' && (!item.target.conversationId || !item.target.replyId)) return null;
    if (item.target.kind === 'sandbox' && (!item.target.sessionId || !item.target.turnId)) return null;
    return item as PendingCorrection;
  } catch { return null; }
}

export function clearPendingCorrection(storage: CorrectionStorage, agentId: string): void {
  storage.removeItem(pendingCorrectionKey(agentId));
}

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
