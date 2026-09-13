import { describe, expect, it } from 'vitest';
import type { AiSandboxSessionDetail, AiSandboxSessionSummary, AiSandboxTurn } from '@rakurs/contract';
import {
  TEST_WARNING,
  acceptTurn,
  beginSend,
  failSend,
  initialChatState,
  openSession,
  reconcileConflict,
  selectTurn,
  selectedTurn,
  startNewSession,
  terminalSessionReason,
  turnCountLabel,
  visibleSessions,
} from './test-chat';

const summary: AiSandboxSessionSummary = {
  id: 'session-1', title: 'Первый тест', phone: null, revision: 2,
  stageId: null, stageName: null, fields: [], outcome: null, handoff: null,
  archivedAt: null, createdAt: '2026-09-12T09:00:00.000Z',
  updatedAt: '2026-09-12T09:02:00.000Z',
};

const turn = (revision: number): AiSandboxTurn => ({
  id: `turn-${revision}`, revision, userText: `Question ${revision}`,
  reply: `Answer ${revision}`, configVersion: 1, model: 'test-model',
  sourceIds: [`source-${revision}`], usedItems: [{ id: `source-${revision}`, title: `Source ${revision}` }],
  stageId: null, stageName: null, fields: [], handoff: null, outcome: 'sent', detail: null,
  photos: [],
  effectSource: 'ai', checkout: null,
  createdAt: `2026-09-12T09:0${revision}:00.000Z`,
});

const detail: AiSandboxSessionDetail = { ...summary, turns: [turn(2), turn(1)] };

describe('test chat state', () => {
  it('renders server turns in revision order and selects the latest effect', () => {
    const state = openSession(initialChatState(), detail);
    expect(state.session?.turns.map((item) => item.id)).toEqual(['turn-1', 'turn-2']);
    expect(selectedTurn(state)?.sourceIds).toEqual(['source-2']);
  });

  it('holds one trimmed message pending and prevents duplicate sends', () => {
    const state = openSession(initialChatState(), detail);
    const pending = beginSend({ ...state, composer: '  Привет  ' });
    expect(pending.pending).toEqual({ text: 'Привет', revision: 2, sessionId: 'session-1' });
    expect(pending.composer).toBe('');
    expect(beginSend({ ...pending, composer: 'Дубль' }).pending).toEqual(pending.pending);
    expect(beginSend({ ...state, composer: '   ' }).pending).toBeNull();
  });

  it('adds only the server-returned turn and its revision', () => {
    const pending = beginSend({ ...openSession(initialChatState(), detail), composer: 'Next' });
    const serverTurn = turn(3);
    const done = acceptTurn(pending, serverTurn);
    expect(done.session?.turns.map((item) => item.id)).toEqual(['turn-1', 'turn-2', 'turn-3']);
    expect(done.session?.revision).toBe(3);
    expect(done.pending).toBeNull();
    expect(selectedTurn(done)?.id).toBe('turn-3');
  });

  it('restores failed text so a retry needs a new explicit send', () => {
    const pending = beginSend({ ...openSession(initialChatState(), detail), composer: 'Try again' });
    const failed = failSend(pending, 'Сервер не отвечает');
    expect(failed.pending).toBeNull();
    expect(failed.composer).toBe('Try again');
    expect(failed.session?.turns).toHaveLength(2);
    expect(failed.error).toBe('Сервер не отвечает');
  });

  it('uses a freshly loaded revision after conflict without resending', () => {
    const pending = beginSend({ ...openSession(initialChatState(), detail), composer: 'Conflicting text' });
    const fresh: AiSandboxSessionDetail = { ...detail, revision: 3, turns: [turn(1), turn(2), turn(3)] };
    const reconciled = reconcileConflict(pending, fresh, 'Сессия изменилась.');
    expect(reconciled.session?.revision).toBe(3);
    expect(reconciled.composer).toBe('Conflicting text');
    expect(reconciled.pending).toBeNull();
    expect(reconciled.error).toContain('отправьте');
  });

  it('restores the draft after send and 409 and waits for explicit retry', () => {
    const started = beginSend({ ...openSession(initialChatState(), detail), composer: '  Вопрос клиента  ' });
    const fresh: AiSandboxSessionDetail = { ...detail, revision: 3, turns: [turn(1), turn(2), turn(3)] };
    const recovered = reconcileConflict(started, fresh, 'Сессия изменилась.');
    expect(recovered.pending).toBeNull();
    expect(recovered.composer).toBe('Вопрос клиента');
    expect(recovered.session?.turns.map((item) => item.id)).toEqual(['turn-1', 'turn-2', 'turn-3']);
    expect(beginSend(recovered).pending).toEqual({ text: 'Вопрос клиента', revision: 3, sessionId: 'session-1' });
  });

  it('preserves a non-revision 409 reason instead of claiming a version conflict', () => {
    const pending = beginSend({ ...openSession(initialChatState(), detail), composer: 'Hello' });
    const recovered = reconcileConflict(pending, detail, 'Ключ OpenRouter не задан.');
    expect(recovered.composer).toBe('Hello');
    expect(recovered.error).toBe('Ключ OpenRouter не задан.');
    expect(recovered.pending).toBeNull();
  });

  it('shows effects for the selected turn rather than the latest one', () => {
    const selected = selectTurn(openSession(initialChatState(), detail), 'turn-1');
    expect(selectedTurn(selected)?.sourceIds).toEqual(['source-1']);
  });

  it('starts a new empty session without carrying over the old transcript', () => {
    const state = openSession(initialChatState(), detail);
    const created = startNewSession(state, { ...summary, id: 'session-2', revision: 0 });
    expect(created.session?.id).toBe('session-2');
    expect(created.session?.turns).toEqual([]);
    expect(selectedTurn(created)).toBeNull();
  });

  it('keeps a newly created session visible when the server list is still stale', () => {
    const created = { ...summary, id: 'session-2', revision: 0 };
    expect(visibleSessions([summary], [created]).map((item) => item.id)).toEqual(['session-2', 'session-1']);
    expect(visibleSessions([created, summary], [created]).map((item) => item.id)).toEqual(['session-2', 'session-1']);
  });

  it('retains multiple locally created sessions across repeated list failures', () => {
    const first = { ...summary, id: 'session-2', revision: 0 };
    const second = { ...summary, id: 'session-3', revision: 0 };
    expect(visibleSessions([summary], [second, first]).map((item) => item.id))
      .toEqual(['session-3', 'session-2', 'session-1']);
  });

  it('uses Russian turn plurals for 1, 2, 5 and 11', () => {
    expect([1, 2, 5, 11, 21].map(turnCountLabel)).toEqual([
      '1 ход', '2 хода', '5 ходов', '11 ходов', '21 ход',
    ]);
  });

  it('does not send from an archived session', () => {
    const state = { ...openSession(initialChatState(), { ...detail, archivedAt: '2026-09-12T11:00:00.000Z' }), composer: 'Another' };
    expect(beginSend(state).pending).toBeNull();
    expect(terminalSessionReason(state.session)).toContain('завершён');
  });

  it('stops after an AI handoff and directs the owner to a new test', () => {
    const pending = beginSend({ ...openSession(initialChatState(), detail), composer: 'Need help' });
    const handedOff = acceptTurn(pending, { ...turn(3), handoff: 'Нужен оператор', outcome: 'handoff' });
    expect(handedOff.session?.handoff).toBe('Нужен оператор');
    expect(beginSend({ ...handedOff, composer: 'Another' }).pending).toBeNull();
    expect(terminalSessionReason(handedOff.session)).toContain('новый тест');
  });

  it('does not carry a draft into a different existing session', () => {
    const state = { ...openSession(initialChatState(), detail), composer: 'Private draft' };
    const other = openSession(state, { ...detail, id: 'session-2', turns: [turn(1)] });
    expect(other.composer).toBe('');
    expect(other.session?.id).toBe('session-2');
  });

  it('keeps the WhatsApp isolation warning exact and unqualified', () => {
    expect(TEST_WARNING).toBe('Тест — сообщения не отправляются в WhatsApp');
  });
});
