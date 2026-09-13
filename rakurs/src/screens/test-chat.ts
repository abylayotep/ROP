import type {
  AiSandboxSessionDetail,
  AiSandboxSessionSummary,
  AiSandboxTurn,
} from '@rakurs/contract';

export const TEST_WARNING = 'Тест — сообщения не отправляются в WhatsApp';

export interface TestChatState {
  session: AiSandboxSessionDetail | null;
  composer: string;
  pending: { text: string; revision: number; sessionId: string } | null;
  selectedTurnId: string | null;
  error: string | null;
}

export function initialChatState(): TestChatState {
  return { session: null, composer: '', pending: null, selectedTurnId: null, error: null };
}

export function openSession(state: TestChatState, session: AiSandboxSessionDetail): TestChatState {
  const turns = [...session.turns].sort((a, b) => a.revision - b.revision);
  return {
    ...state,
    session: { ...session, turns },
    composer: state.session?.id === session.id ? state.composer : '',
    pending: null,
    selectedTurnId: turns.length ? turns[turns.length - 1].id : null,
    error: null,
  };
}

export function beginSend(state: TestChatState): TestChatState {
  const text = state.composer.trim();
  if (!state.session || state.pending || terminalSessionReason(state.session) || text === '') return state;
  return {
    ...state,
    composer: '',
    error: null,
    pending: { text, revision: state.session.revision, sessionId: state.session.id },
  };
}

export function acceptTurn(state: TestChatState, turn: AiSandboxTurn): TestChatState {
  if (!state.session || !state.pending || state.pending.sessionId !== state.session.id) return state;
  return {
    ...state,
    session: {
      ...state.session,
      revision: turn.revision,
      handoff: turn.handoff ?? state.session.handoff,
      outcome: turn.outcome,
      turns: [...state.session.turns.filter((item) => item.id !== turn.id), turn]
        .sort((a, b) => a.revision - b.revision),
    },
    pending: null,
    selectedTurnId: turn.id,
    error: null,
  };
}

export function failSend(state: TestChatState, error: string): TestChatState {
  if (!state.pending) return state;
  return { ...state, composer: state.pending.text, pending: null, error };
}

export function reconcileConflict(
  state: TestChatState,
  fresh: AiSandboxSessionDetail,
  serverError: string,
): TestChatState {
  const text = state.pending?.text ?? state.composer;
  return {
    ...openSession(state, fresh),
    composer: text,
    error: fresh.revision === state.pending?.revision
      ? serverError
      : 'Сессия изменилась. Проверьте новые сообщения и отправьте текст ещё раз.',
  };
}

export function selectTurn(state: TestChatState, turnId: string): TestChatState {
  if (!state.session?.turns.some((turn) => turn.id === turnId)) return state;
  return { ...state, selectedTurnId: turnId };
}

export function selectedTurn(state: TestChatState): AiSandboxTurn | null {
  return state.session?.turns.find((turn) => turn.id === state.selectedTurnId) ?? null;
}

export function startNewSession(
  state: TestChatState,
  summary: AiSandboxSessionSummary,
): TestChatState {
  return {
    ...state,
    session: { ...summary, turns: [] },
    composer: '',
    pending: null,
    selectedTurnId: null,
    error: null,
  };
}

export function terminalSessionReason(session: AiSandboxSessionSummary | null): string | null {
  if (session?.archivedAt) return 'Этот тест завершён. Создайте новый тест, чтобы продолжить.';
  if (session?.handoff) return 'Диалог был бы передан человеку. Создайте новый тест для другого сценария.';
  return null;
}

export function visibleSessions(
  serverSessions: AiSandboxSessionSummary[],
  createdSessions: AiSandboxSessionSummary[],
): AiSandboxSessionSummary[] {
  const serverIds = new Set(serverSessions.map((session) => session.id));
  return [...createdSessions.filter((session) => !serverIds.has(session.id)), ...serverSessions];
}

export function turnCountLabel(count: number): string {
  const lastTwo = count % 100;
  const last = count % 10;
  const noun = lastTwo >= 11 && lastTwo <= 14
    ? 'ходов'
    : last === 1 ? 'ход' : last >= 2 && last <= 4 ? 'хода' : 'ходов';
  return `${count} ${noun}`;
}
