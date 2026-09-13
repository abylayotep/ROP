import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import * as api from '@/api';
import { ProposalCard } from '@/components/coach/ProposalCard';
import { Card } from '@/components/ui/primitives';
import { Async, EmptyState, Skeleton } from '@/components/ui/states';
import { useToast } from '@/components/ui/Toast';
import { useApi } from '@/hooks/useApi';
import { withoutCorrectionParams } from '@/lib/training-routes';
import type { AgentRule, CoachMessage, ConversationThread } from '@/types';
import { clearPendingCorrection, correctionSource, correctionText, readPendingCorrection,
  savePendingCorrection, type CorrectionTarget, type PendingCorrection } from '@/screens/response-feedback';

/**
 * «Научить» → «Спросить тренера»: a chat where the owner teaches the agent, or corrects one
 * reply «Так нельзя» was clicked on. The rules themselves live in «Как отвечает»; this column
 * only links there, and still loads them because a proposal is read against the rule it
 * would change (`ProposalCard`).
 *
 * Every route this component calls is owner-only on the server, the read included (see
 * `server/src/api/rules.ts` and `server/src/api/coach.ts`). `TrainingScreen` mounts it only
 * inside «Научить», a tab a non-owner never sees.
 */

const control: CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  background: 'var(--sunken)',
  color: 'var(--text)',
  border: '1px solid var(--line)',
  borderRadius: 8,
  font: 'inherit',
  fontSize: 12.5,
  lineHeight: 1.5,
  outline: 'none',
  resize: 'vertical',
};

interface Loaded {
  messages: CoachMessage[];
  rules: AgentRule[];
}

export function CoachChat({ agentId, onOpenRules }: { agentId: string; onOpenRules: () => void }) {
  const query = useApi<Loaded>(
    async (signal) => {
      const [messages, rules] = await Promise.all([
        api.listCoachMessages(agentId, signal),
        api.listRules(agentId, signal),
      ]);
      return { messages, rules };
    },
    [agentId],
  );

  return (
    <Async state={query} skeleton={<Skeleton height={480} />}>
      {(loaded) => (
        // Keyed on the agent: a coaching chat must not survive under an agent the URL moved on to.
        <Coach key={agentId} agentId={agentId} loaded={loaded} onOpenRules={onOpenRules} />
      )}
    </Async>
  );
}

function Coach({ agentId, loaded, onOpenRules }: { agentId: string; loaded: Loaded; onOpenRules: () => void }) {
  const toast = useToast();
  const [messages, setMessages] = useState<CoachMessage[]>(loaded.messages);
  const rules = loaded.rules;
  const activeRules = rules.filter((rule) => rule.enabled).length;
  const [text, setText] = useState('');
  const [correctionType, setCorrectionType] = useState<'fact' | 'behavior'>('fact');
  const [sending, setSending] = useState(false);
  const [pendingCorrection, setPendingCorrection] = useState<PendingCorrection | null>(() => {
    try { return typeof window === 'undefined' ? null : readPendingCorrection(window.localStorage, agentId); }
    catch { return null; }
  });
  const pendingRef = useRef(pendingCorrection);
  const [pendingStatus, setPendingStatus] = useState<'pending' | 'failed' | 'unknown'>('unknown');
  const bottomRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  // The dialog «Так нельзя» was clicked from, if any. Read straight out of the URL rather
  // than copied into state on mount: `Coach` stays mounted (keyed on the agent, not on this
  // param) for as long as the owner stays on the screen, so a value copied once would go
  // stale the moment the owner detaches or the sidebar's own link — no query string at all —
  // brings them back here later. Reading the param itself means there is nothing to go stale.
  const [params, setParams] = useSearchParams();
  const conversationId = params.get('conversation');
  // The particular reply «Так нельзя» sat on, when the button carried one — read the same
  // way and for the same reason as `conversationId` itself, right above.
  const aiReplyId = params.get('reply');
  const sandboxSessionId = params.get('session');
  const sandboxTurnId = params.get('turn');
  const selectedTarget: CorrectionTarget | null = sandboxSessionId && sandboxTurnId
    ? { kind: 'sandbox', sessionId: sandboxSessionId, turnId: sandboxTurnId }
    : conversationId && aiReplyId
      ? { kind: 'live', conversationId, replyId: aiReplyId }
      : null;
  const correctionTarget = pendingCorrection?.target ?? selectedTarget;
  const previewKey = correctionTarget ? JSON.stringify(correctionSource(correctionTarget)) : '';
  const preview = useApi(async (signal) => correctionTarget
    ? { key: previewKey, snapshot: await api.previewResponseFeedback(agentId, correctionSource(correctionTarget), signal) }
    : null, [agentId, previewKey]);
  const previewReady = !correctionTarget || (preview.data?.key === previewKey && !preview.error);
  const detach = () => setParams(withoutCorrectionParams(params), { replace: true });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'nearest' });
  }, [messages.length]);

  // Focuses the composer the moment a dialog gets attached — that is exactly when the owner
  // is meant to start typing their complaint, transcript already in hand.
  useEffect(() => {
    if (conversationId !== null) textRef.current?.focus();
  }, [conversationId]);

  async function checkFeedbackStatus() {
    const pending = pendingRef.current;
    if (!pending) return;
    try {
      const status = await api.getCoachFeedbackRequest(agentId, pending.requestKey);
      if (status.status === 'completed' && status.message) {
        try { setMessages(await api.listCoachMessages(agentId)); }
        catch { setMessages((prev) => [...prev, status.message!]); }
        clearPendingCorrection(window.localStorage, agentId);
        pendingRef.current = null;
        setPendingCorrection(null);
        setParams((prev) => withoutCorrectionParams(prev), { replace: true });
      } else setPendingStatus(status.status === 'failed' ? 'failed' : 'pending');
    } catch {
      setPendingStatus('unknown');
    }
  }

  useEffect(() => {
    if (!pendingCorrection) return;
    void checkFeedbackStatus();
    const timer = setInterval(() => void checkFeedbackStatus(), 5_000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingCorrection?.requestKey, agentId]);

  async function send(event: FormEvent) {
    event.preventDefault();
    const value = text.trim();
    if (value === '' || sending || pendingCorrection || !previewReady) return;

    setSending(true);
    let requestKey: string | undefined;
    if (correctionTarget) {
      const pending: PendingCorrection = { requestKey: crypto.randomUUID(), target: correctionTarget,
        note: value, correctionType };
      try { savePendingCorrection(window.localStorage, agentId, pending); }
      catch { setSending(false); toast.fail(new Error('Не удалось сохранить ключ запроса в браузере')); return; }
      requestKey = pending.requestKey;
      pendingRef.current = pending;
      setPendingCorrection(pending);
      setPendingStatus('unknown');
    }
    // Shown right away — the owner's own line does not need the model's turn to finish to
    // appear, and it costs nothing to write locally.
    const ownerLine: CoachMessage = {
      id: `local-${Date.now()}`,
      role: 'owner',
      text: value,
      proposal: null,
      warning: null,
      status: 'pending',
      draftId: null,
      conversationId,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, ownerLine]);
    setText('');

    try {
      const reply = await api.sendCoachMessage(agentId, {
        text: value,
        conversationId: conversationId ?? undefined,
        aiReplyId: aiReplyId ?? undefined,
        requestKey,
        feedback: correctionTarget ? {
          source: correctionSource(correctionTarget), correctionType, note: correctionText(value)!,
        } : undefined,
      });
      if (!('id' in reply)) {
        setPendingStatus('pending');
        return;
      }
      let savedReply: CoachMessage | undefined;
      try {
        savedReply = (await api.listCoachMessages(agentId)).find((item) => item.id === reply.id);
      } catch {
        // The proposal was already persisted. A failed refresh must not turn the submitted
        // feedback into a retryable send, which would create a duplicate coaching turn.
      }
      setMessages((prev) => [
        ...prev,
        savedReply ?? {
          id: reply.id,
          role: 'model',
          text: reply.message,
          proposal: reply.proposal,
          warning: reply.warning,
          status: 'pending',
          draftId: null,
          conversationId,
          createdAt: new Date().toISOString(),
        },
      ]);
      if (correctionTarget) {
        clearPendingCorrection(window.localStorage, agentId);
        pendingRef.current = null;
        setPendingCorrection(null);
        setParams((prev) => withoutCorrectionParams(prev), { replace: true });
      }
    } catch (error) {
      if (correctionTarget) {
        setPendingStatus('unknown');
        void checkFeedbackStatus();
        return;
      }
      // The turn never happened — its line does not stay, and the text goes back into the
      // box so retyping a paragraph is not the price of a failed send.
      setMessages((prev) => prev.filter((m) => m.id !== ownerLine.id));
      setText(value);
      toast.fail(error);
    } finally {
      setSending(false);
    }
  }

  function onRejected(updated: CoachMessage) {
    setMessages((prev) => prev.map((m) => (m.id === updated.id ? { ...m, status: updated.status } : m)));
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
      {conversationId !== null && (
        <AttachedDialog agentId={agentId} conversationId={conversationId} onDetach={detach} />
      )}
      {correctionTarget && <CorrectionContext agentId={agentId} target={correctionTarget} messageId={params.get('message')} preview={preview} previewKey={previewKey} />}
      <Card pad={false}>
        <div
          style={{
            padding: 16,
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
            minHeight: 320,
            maxHeight: 600,
            overflowY: 'auto',
          }}
        >
          {messages.length === 0 ? (
            <EmptyState>
              Расскажите, как агенту говорить, о чём спрашивать и что никогда не обещать.
              Коуч предложит правило — оно ничего не меняет, пока вы не согласитесь.
            </EmptyState>
          ) : (
            messages.map((message) => (
              <div
                key={message.id}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                  alignItems: message.role === 'owner' ? 'flex-end' : 'flex-start',
                }}
              >
                <div
                  className={message.role === 'model' ? 'sunken-box' : undefined}
                  style={{
                    maxWidth: '85%',
                    padding: '9px 12px',
                    borderRadius: 10,
                    fontSize: 12.5,
                    lineHeight: 1.5,
                    whiteSpace: 'pre-wrap',
                    background: message.role === 'owner' ? 'var(--accent-2)' : undefined,
                    color: message.role === 'owner' ? 'var(--on-accent)' : undefined,
                  }}
                >
                  {message.text}
                </div>
                {message.role === 'model' && message.proposal && (
                  <>
                    {message.sourceSnapshot && <div className="sunken-box" style={{ maxWidth: '85%', fontSize: 12 }}>
                      <strong>Исходный ответ</strong><p>{message.sourceSnapshot.responseText}</p>
                      <strong>Проверенные источники</strong>
                      {message.sourceSnapshot.sourceRecords.length
                        ? <ul>{message.sourceSnapshot.sourceRecords.map((source) =>
                          <li key={source.id}>{source.title}: {source.content}</li>)}</ul>
                        : <p>Источники не использовались.</p>}
                    </div>}
                    <ProposalCard agentId={agentId} message={message} rules={rules} onRejected={onRejected} />
                  </>
                )}
              </div>
            ))
          )}
          <div ref={bottomRef} />
        </div>
      </Card>

      <form onSubmit={send} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {pendingCorrection && <div role="alert">{pendingStatus === 'failed'
          ? 'Исправление завершилось с ошибкой. Этот запрос не будет повторно запускать модель.'
          : pendingStatus === 'pending' ? 'Коуч ещё обрабатывает исправление. Повторная отправка заблокирована.'
            : 'Статус исправления неизвестен: коуч мог сохранить предложение. Повторная отправка заблокирована.'}
          <button type="button" className="btn btn-sm" onClick={() => void checkFeedbackStatus()}>Проверить статус</button>
          <button type="button" className="btn btn-sm" onClick={() => {
            clearPendingCorrection(window.localStorage, agentId);
            pendingRef.current = null;
            setPendingCorrection(null);
            setText(pendingCorrection.note);
            setMessages((prev) => prev.filter((item) => !item.id.startsWith('local-')));
          }}>Я понимаю риск и начну новое исправление</button>
        </div>}
        {correctionTarget && !previewReady && <p role="status">{preview.error
          ? 'Не удалось проверить источники. Повторите загрузку страницы перед отправкой.'
          : 'Проверяем источники перед отправкой…'}</p>}
        {correctionTarget && <>
          <label htmlFor="correction-type">Тип исправления</label>
          <select id="correction-type" value={correctionType} onChange={(event) => setCorrectionType(event.target.value as 'fact' | 'behavior')}>
            <option value="fact">Неверная информация</option>
            <option value="behavior">Неверное поведение</option>
          </select>
          <label htmlFor="correction-note">Как нужно исправить ответ</label>
        </>}
        <textarea
          id={correctionTarget ? 'correction-note' : undefined}
          ref={textRef}
          style={{ ...control, minHeight: 72 }}
          value={text}
          disabled={sending || !!pendingCorrection}
          placeholder="Например: мы продаём мебель на заказ, всегда спрашиваем город и срок"
          onChange={(e) => setText(e.target.value)}
        />
        <button type="button" className="btn-sm" onClick={onOpenRules} style={{ alignSelf: 'flex-start' }}>
          Правила: {activeRules} активных →
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button type="submit" className="btn" disabled={sending || !!pendingCorrection || !previewReady || correctionText(text) === null}>
            {sending ? 'Коуч отвечает…' : correctionTarget ? 'Создать предложение' : 'Отправить'}
          </button>
          {/* Every turn is a real OpenRouter call, the same money a sandbox run spends —
              said next to the button that spends it, not buried in a tooltip. */}
          <span style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>
            Каждое сообщение коучу оплачивается с вашего счёта в OpenRouter.
          </span>
        </div>
      </form>
    </div>
  );
}

function CorrectionContext({ agentId, target, messageId, preview, previewKey }: {
  agentId: string; target: CorrectionTarget; messageId: string | null;
  preview: ReturnType<typeof useApi<{ key: string; snapshot: import('@rakurs/contract').CoachSourceSnapshot } | null>>;
  previewKey: string;
}) {
  const context = useApi(async (signal) => target.kind === 'sandbox'
    ? api.getAiSandboxSession(agentId, target.sessionId, signal)
    : api.getConversation(agentId, target.conversationId, signal,
      messageId ? { limit: 30, around: messageId } : undefined),
  [agentId, target.kind, target.kind === 'sandbox' ? target.sessionId : target.conversationId, messageId]);
  if (context.error) return <Card>Не удалось загрузить ответ. Проверьте доступ и обновите страницу.</Card>;
  if (!context.data) return <Card>Загружаем выбранный ответ…</Card>;
  if (target.kind === 'sandbox') {
    const session = context.data as Awaited<ReturnType<typeof api.getAiSandboxSession>>;
    const index = session.turns.findIndex((turn) => turn.id === target.turnId);
    const turn = session.turns[index];
    if (!turn?.reply) return <Card>Выбранный ответ не найден. Вернитесь в тест и выберите другой ответ.</Card>;
    return <Card>
      <h3>Исправление тестового ответа</h3>
      {session.turns.slice(Math.max(0, index - 2), index + 1).map((item) =>
        <p key={item.id}>Клиент: {item.userText}<br />Агент: {item.reply ?? 'Без ответа'}</p>)}
      <strong>Проверенные источники ответа</strong>
      <VerifiedSources preview={preview} previewKey={previewKey} />
    </Card>;
  }
  const thread = context.data as ConversationThread;
  const index = thread.messages.findIndex((message) => message.aiReplyId === target.replyId);
  if (index < 0) return <Card>Выбранный ответ не найден в загруженной переписке. Проверьте его в диалоге.</Card>;
  return <Card>
    <h3>Исправление ответа в диалоге</h3>
    {thread.messages.slice(Math.max(0, index - 5), index + 1).map((message) =>
      <p key={message.id}>{message.author === 'ai' ? 'Агент' : message.author === 'client' ? 'Клиент' : 'Оператор'}: {message.body}</p>)}
    <strong>Проверенные источники выбранного ответа</strong>
    <VerifiedSources preview={preview} previewKey={previewKey} />
  </Card>;
}

function VerifiedSources({ preview, previewKey }: {
  preview: ReturnType<typeof useApi<{ key: string; snapshot: import('@rakurs/contract').CoachSourceSnapshot } | null>>;
  previewKey: string;
}) {
  if (preview.error) return <p role="alert">Не удалось проверить источники. Обновите страницу перед отправкой исправления.</p>;
  if (!preview.data || preview.data.key !== previewKey) return <p>Проверяем источники ответа…</p>;
  return preview.data.snapshot.sourceRecords.length
    ? <ul>{preview.data.snapshot.sourceRecords.map((source) => <li key={source.id}>{source.title}: {source.content}</li>)}</ul>
    : <p>Источники не использовались.</p>;
}

/**
 * The banner above the composer while a dialog is attached — named so the owner knows what
 * they are about to complain about before they type a word, and can detach it if «Так
 * нельзя» was clicked on the wrong bubble.
 *
 * `useApi`'s own deps array already carries `conversationId`, so a second «Так нельзя»
 * click on a different dialog clears the fetched thread and re-fetches on its own — no `key`
 * needed here for the first dialog's contact name to stop showing while the new one loads.
 */
function AttachedDialog({
  agentId,
  conversationId,
  onDetach,
}: {
  agentId: string;
  conversationId: string;
  onDetach: () => void;
}) {
  const thread = useApi<ConversationThread>(
    (signal) => api.getConversation(agentId, conversationId, signal),
    [agentId, conversationId],
  );

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 12px',
        background: 'var(--sunken)',
        border: '1px solid var(--line-soft)',
        borderRadius: 8,
        fontSize: 12,
      }}
    >
      <span className="ellipsis">
        Речь о переписке{thread.data ? ` с ${thread.data.contactName ?? thread.data.contactPhone}` : ''}
      </span>
      <button
        type="button"
        onClick={onDetach}
        style={{
          marginLeft: 'auto',
          fontSize: 11.5,
          color: 'var(--text-dim)',
          background: 'none',
          border: 0,
          padding: 0,
          cursor: 'pointer',
          textDecoration: 'underline',
          flex: '0 0 auto',
        }}
      >
        Отменить
      </button>
    </div>
  );
}
