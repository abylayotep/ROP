import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { AiSandboxSessionSummary, AiSandboxTurn } from '@rakurs/contract';
import * as api from '@/api';
import { Card } from '@/components/ui/primitives';
import { ErrorState, Skeleton } from '@/components/ui/states';
import { useApi } from '@/hooks/useApi';
import { useAgent } from '@/store/agent';
import {
  TEST_WARNING, acceptTurn, beginSend, failSend, initialChatState, openSession,
  reconcileConflict, selectTurn, selectedTurn, startNewSession,
} from './test-chat';
import './test-screen.css';

const outcomeLabels: Record<string, string> = {
  sent: 'Ответ отправился бы клиенту',
  unrecorded: 'Ответ отправился бы, но не записался бы',
  applied: 'Карточка лида обновилась бы без ответа',
  handoff: 'Диалог перешёл бы человеку',
  failed: 'Ответ не дошёл бы',
  skipped: 'Агент не стал бы отвечать',
};

export function TestScreen() {
  const { agent, role } = useAgent();
  return (
    <div className="test-screen">
      <div className="test-warning" role="note">{TEST_WARNING}</div>
      {role === 'owner' ? (
        <TestWorkspace key={agent.id} agentId={agent.id} />
      ) : (
        <Card>Тестирование агента доступно только владельцу компании.</Card>
      )}
    </div>
  );
}

function TestWorkspace({ agentId }: { agentId: string }) {
  const sessions = useApi((signal) => api.listAiSandboxSessions(agentId, signal), [agentId]);
  const [chat, setChat] = useState(initialChatState);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loadingSession, setLoadingSession] = useState(false);
  const [creating, setCreating] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);
  const requestSequence = useRef(0);
  const sending = useRef(false);

  async function loadSession(id: string) {
    if (sending.current || creating) return;
    const sequence = ++requestSequence.current;
    setSelectedId(id);
    setLoadingSession(true);
    setLoadError(null);
    try {
      const detail = await api.getAiSandboxSession(agentId, id);
      if (sequence === requestSequence.current) setChat((current) => openSession(current, detail));
    } catch (error) {
      if (sequence === requestSequence.current) setLoadError(error);
    } finally {
      if (sequence === requestSequence.current) setLoadingSession(false);
    }
  }

  useEffect(() => {
    if (selectedId === null && sessions.data?.length) void loadSession(sessions.data[0].id);
    // The list is the trigger; a local chat change must never reopen an old session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions.data, selectedId]);

  async function createSession() {
    if (creating || sending.current) return;
    ++requestSequence.current;
    setCreating(true);
    setLoadError(null);
    try {
      const created = await api.createAiSandboxSession(agentId);
      setSelectedId(created.id);
      setChat((current) => startNewSession(current, created));
      sessions.reload();
    } catch (error) {
      setLoadError(error);
    } finally {
      setCreating(false);
      setLoadingSession(false);
    }
  }

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending.current) return;
    const next = beginSend(chat);
    if (next === chat || !next.pending) return;
    const pending = next.pending;
    sending.current = true;
    setChat(next);
    try {
      const turn = await api.sendAiSandboxTurn(agentId, pending.sessionId, {
        text: pending.text, revision: pending.revision,
      });
      setChat((current) => acceptTurn(current, turn));
      sessions.reload();
    } catch (error) {
      if (error instanceof api.ApiError && error.status === 409) {
        try {
          const fresh = await api.getAiSandboxSession(agentId, pending.sessionId);
          setChat((current) => reconcileConflict(current, fresh, api.humanError(error)));
          sessions.reload();
        } catch (reloadError) {
          setChat((current) => failSend(current, api.humanError(reloadError)));
        }
      } else {
        setChat((current) => failSend(current, api.humanError(error)));
      }
    } finally {
      sending.current = false;
    }
  }

  const currentSession = chat.session?.id === selectedId ? chat.session : null;
  const activeTurn = currentSession && !loadingSession ? selectedTurn(chat) : null;
  const list = sessions.data ?? [];

  return (
    <div className="test-workspace">
      <Card pad={false} className="test-sessions">
        <div className="test-panel-head">
          <div>
            <div className="eyebrow">ПЕСОЧНИЦА</div>
            <h2>Тестирование</h2>
          </div>
          <button type="button" className="btn btn-sm" onClick={createSession}
            disabled={creating || !!chat.pending}>
            {creating ? 'Создаём…' : 'Новый тест'}
          </button>
        </div>
        {sessions.error !== undefined && sessions.data === undefined ? (
          <ErrorState error={sessions.error} onRetry={sessions.reload} compact />
        ) : sessions.data === undefined ? (
          <div className="test-list-loading"><Skeleton height={38} /><Skeleton height={38} /></div>
        ) : list.length === 0 ? (
          <p className="test-list-empty">Пока нет тестов. Создайте первый, чтобы проверить ответы агента.</p>
        ) : (
          <div className="test-session-list">
            {list.map((session: AiSandboxSessionSummary) => (
              <button key={session.id} type="button"
                className={`test-session ${selectedId === session.id ? 'test-session-active' : ''}`}
                onClick={() => void loadSession(session.id)} disabled={!!chat.pending || creating}
                aria-current={selectedId === session.id ? 'true' : undefined}>
                <span className="test-session-title">{session.title || `Тест от ${new Date(session.createdAt).toLocaleDateString('ru-RU')}`}</span>
                <span className="test-session-meta">{session.revision} {session.revision === 1 ? 'ход' : 'ходов'}</span>
              </button>
            ))}
          </div>
        )}
      </Card>

      <Card pad={false} className="test-chat">
        {loadError ? (
          <ErrorState error={loadError} onRetry={() => selectedId && void loadSession(selectedId)} />
        ) : loadingSession ? (
          <div className="test-chat-empty"><Skeleton height={30} width="65%" /></div>
        ) : !currentSession ? (
          <div className="test-chat-empty">Выберите тест или создайте новый</div>
        ) : (
          <>
            <div className="test-chat-head">
              <span className="test-avatar">Т</span>
              <div>
                <strong>{currentSession.title || 'Новый тест'}</strong>
                <span>Разговор с агентом · только симуляция</span>
              </div>
            </div>
            <div className="test-transcript" aria-label="Тестовая переписка">
              {currentSession.turns.length === 0 && !chat.pending && (
                <div className="test-transcript-empty">Напишите сообщение так, как его написал бы клиент.</div>
              )}
              {currentSession.turns.map((turn) => (
                <div className="test-exchange" key={turn.id}>
                  <div className="test-bubble test-bubble-user">{turn.userText}</div>
                  <button type="button"
                    className={`test-bubble test-bubble-agent ${chat.selectedTurnId === turn.id ? 'test-bubble-selected' : ''}`}
                    onClick={() => setChat((state) => selectTurn(state, turn.id))}
                    aria-pressed={chat.selectedTurnId === turn.id}>
                    {turn.reply ?? 'Агент не ответил'}
                    <small>Ход {turn.revision} · показать источники и эффекты</small>
                  </button>
                </div>
              ))}
              {chat.pending && (
                <div className="test-exchange" aria-live="polite">
                  <div className="test-bubble test-bubble-user">{chat.pending.text}</div>
                  <div className="test-bubble test-bubble-wait">Агент отвечает…</div>
                </div>
              )}
            </div>
            {chat.error && <div className="test-send-error" role="alert">{chat.error}</div>}
            <form className="test-composer" onSubmit={send}>
              <label className="sr-only" htmlFor="test-message">Сообщение клиента</label>
              <textarea id="test-message" value={chat.composer}
                onChange={(event) => setChat((state) => ({ ...state, composer: event.target.value }))}
                disabled={!!chat.pending} maxLength={4000} rows={2}
                placeholder="Сообщение клиента…" />
              <button type="submit" className="btn btn-accent" disabled={!!chat.pending || !chat.composer.trim()}>
                {chat.pending ? 'Ждём ответа…' : 'Отправить'}
              </button>
            </form>
          </>
        )}
      </Card>

      <TestTurnInspector turn={activeTurn} />
    </div>
  );
}

export function TestTurnInspector({ turn }: { turn: AiSandboxTurn | null }) {
  return (
    <Card pad={false} className="test-inspector">
      <div className="test-panel-head">
        <div>
          <div className="eyebrow">РАЗБОР ХОДА</div>
          <h2>Источники и эффекты</h2>
        </div>
      </div>
      {!turn ? (
        <p className="test-inspector-empty">Выберите ответ агента, чтобы увидеть, на что он опирался и что изменил бы.</p>
      ) : (
        <div className="test-inspector-body">
          <div className="test-inspector-group">
            <h3>Источники</h3>
            {turn.usedItems.length ? (
              <ul>{turn.usedItems.map((item) => <li key={item.id}>{item.title}</li>)}</ul>
            ) : turn.sourceIds.length ? (
              <ul>{turn.sourceIds.map((id) => <li key={id}>Источник {id}</li>)}</ul>
            ) : <p>Источники не использовались.</p>}
          </div>
          <div className="test-inspector-group">
            <h3>Предполагаемый результат</h3>
            <p>{outcomeLabels[turn.outcome] ?? turn.outcome}</p>
            {turn.detail && <p>{turn.detail}</p>}
            {turn.stageName && <p>Этап: {turn.stageName}</p>}
            {turn.fields.map((field) => <p key={field.id}>{field.name}: {field.value}</p>)}
            {turn.handoff && <p>Передача человеку: {turn.handoff}</p>}
          </div>
          <div className="test-inspector-group test-inspector-meta">
            <h3>Версия ответа</h3>
            <p>Настройки: {turn.configVersion} · модель: {turn.model}</p>
          </div>
          <div className="test-inspector-actions">
            <button type="button" className="btn" disabled>Исправить ответ</button>
            <button type="button" className="btn" disabled>Сохранить как тест-кейс</button>
            <p>Исправление ответа и сохранение тест-кейса пока недоступны в тестировании.</p>
          </div>
        </div>
      )}
    </Card>
  );
}
