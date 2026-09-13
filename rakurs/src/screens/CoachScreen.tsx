import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import * as api from '@/api';
import { ProposalCard } from '@/components/coach/ProposalCard';
import { RuleList } from '@/components/coach/RuleList';
import { Card, CardHead } from '@/components/ui/primitives';
import { Async, EmptyState, Skeleton } from '@/components/ui/states';
import { useToast } from '@/components/ui/Toast';
import { useApi } from '@/hooks/useApi';
import { useAgent } from '@/store/agent';
import type { AgentRule, CoachMessage, ConversationThread, KbDraft } from '@/types';
import { correctionSource, correctionText, findCompletedFeedback, type CorrectionTarget } from './response-feedback';

/**
 * Обучение: a chat where the owner teaches the agent, and the rules that chat has already
 * produced or that the owner typed by hand — side by side, because a proposal is read
 * against the rule it would change.
 *
 * Every route this screen calls is owner-only on the server, the read included (see
 * `server/src/api/rules.ts` and `server/src/api/coach.ts`) — a rule shapes what the agent
 * costs to run, and a coaching turn spends real money. A non-owner gets a plain message
 * instead of a screen that would fail every request it made.
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

export function CoachScreen() {
  const { agent, role } = useAgent();
  const owner = role === 'owner';

  // Called unconditionally — a hook cannot be skipped by an early return — but the fetcher
  // itself never calls an owner-only route for anyone but the owner.
  const query = useApi<Loaded>(
    async (signal) => {
      if (!owner) return { messages: [], rules: [] };
      const [messages, rules] = await Promise.all([
        api.listCoachMessages(agent.id, signal),
        api.listRules(agent.id, signal),
      ]);
      return { messages, rules };
    },
    [agent.id, owner],
  );

  if (!owner) {
    return (
      <Card>
        <EmptyState>Обучение агента — дело владельца компании. У вас нет доступа к этому разделу.</EmptyState>
      </Card>
    );
  }

  return (
    <Async state={query} skeleton={<Skeleton height={480} />}>
      {(loaded) => (
        // Keyed on the agent: a coaching chat and its rules must not survive under an agent
        // the URL moved on to.
        <Coach key={agent.id} agentId={agent.id} loaded={loaded} />
      )}
    </Async>
  );
}

function Coach({ agentId, loaded }: { agentId: string; loaded: Loaded }) {
  const toast = useToast();
  const [messages, setMessages] = useState<CoachMessage[]>(loaded.messages);
  const [rules, setRules] = useState<AgentRule[]>(loaded.rules);
  const [text, setText] = useState('');
  const [correctionType, setCorrectionType] = useState<'fact' | 'behavior'>('fact');
  const [sending, setSending] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const pendingFeedback = useRef<{ existing: Set<string>; note: string } | null>(null);
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
  const correctionTarget: CorrectionTarget | null = sandboxSessionId && sandboxTurnId
    ? { kind: 'sandbox', sessionId: sandboxSessionId, turnId: sandboxTurnId }
    : conversationId && aiReplyId
      ? { kind: 'live', conversationId, replyId: aiReplyId }
      : null;
  const detach = () => setParams({}, { replace: true });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'nearest' });
  }, [messages.length]);

  // Focuses the composer the moment a dialog gets attached — that is exactly when the owner
  // is meant to start typing their complaint, transcript already in hand.
  useEffect(() => {
    if (conversationId !== null) textRef.current?.focus();
  }, [conversationId]);

  async function checkFeedbackStatus() {
    const pending = pendingFeedback.current;
    if (!pending) return;
    try {
      const fresh = await api.listCoachMessages(agentId);
      const related = fresh.filter((item) => item.feedbackId && !pending.existing.has(item.feedbackId));
      const completed = findCompletedFeedback(fresh, pending.existing, pending.note);
      if (completed) {
        setMessages(fresh);
        pendingFeedback.current = null;
        setUncertain(false);
        setParams({}, { replace: true });
      } else if (related.some((item) => item.role === 'owner' && item.text === pending.note)) {
        setMessages(fresh);
      }
    } catch {
      // The status remains unknown. Keep the composer blocked rather than resending.
    }
  }

  useEffect(() => {
    if (!uncertain) return;
    const timer = setInterval(() => void checkFeedbackStatus(), 5_000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uncertain, agentId]);

  async function send(event: FormEvent) {
    event.preventDefault();
    const value = text.trim();
    if (value === '' || sending || uncertain) return;

    setSending(true);
    if (correctionTarget) pendingFeedback.current = {
      existing: new Set(messages.map((item) => item.feedbackId).filter((id): id is string => !!id)),
      note: value,
    };
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
        feedback: correctionTarget ? {
          source: correctionSource(correctionTarget), correctionType, note: correctionText(value)!,
        } : undefined,
      });
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
      if (correctionTarget) setParams({}, { replace: true });
      pendingFeedback.current = null;
    } catch (error) {
      if (correctionTarget && !(error instanceof api.ApiError && error.status >= 400 && error.status < 500)) {
        setUncertain(true);
        void checkFeedbackStatus();
        return;
      }
      pendingFeedback.current = null;
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
    <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
      <div style={{ flex: '1 1 54%', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {conversationId !== null && (
          <AttachedDialog agentId={agentId} conversationId={conversationId} onDetach={detach} />
        )}
        {correctionTarget && <CorrectionContext agentId={agentId} target={correctionTarget} messageId={params.get('message')} />}
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
          {uncertain && <div role="alert">Статус исправления неизвестен: коуч мог сохранить предложение. Повторная отправка заблокирована.
            <button type="button" className="btn btn-sm" onClick={() => void checkFeedbackStatus()}>Проверить статус</button>
          </div>}
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
            disabled={sending || uncertain}
            placeholder="Например: мы продаём мебель на заказ, всегда спрашиваем город и срок"
            onChange={(e) => setText(e.target.value)}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button type="submit" className="btn" disabled={sending || uncertain || correctionText(text) === null}>
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

      <div style={{ flex: '1 1 46%', minWidth: 340, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <OpenDrafts agentId={agentId} />
        <RuleList agentId={agentId} rules={rules} onChanged={setRules} />
      </div>
    </div>
  );
}

/**
 * The way back into a draft an owner left before deciding — «В черновик» already lands on one
 * directly, but leaving `DraftScreen` used to lose it for good: nothing named where to find it
 * again. Shown only when there is something to show; an owner with no open draft sees nothing
 * extra here.
 */
function OpenDrafts({ agentId }: { agentId: string }) {
  const navigate = useNavigate();
  const drafts = useApi<KbDraft[]>((signal) => api.listOpenDrafts(agentId, signal), [agentId]);
  const list = drafts.data ?? [];

  // A failed list must not read as «черновиков нет»: an owner who left one here would believe
  // it had been applied or thrown away, and stop looking for it.
  if (drafts.error) {
    return (
      <Card>
        <CardHead title="Черновики на проверке" />
        <div className="muted">Не удалось загрузить список. Обновите страницу.</div>
      </Card>
    );
  }

  if (list.length === 0) return null;

  return (
    <Card>
      <CardHead title="Черновики на проверке" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {list.map((draft) => (
          <button
            key={draft.id}
            type="button"
            className="sunken-box"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
              padding: '9px 10px',
              border: 0,
              cursor: 'pointer',
              font: 'inherit',
              fontSize: 12.5,
              color: 'var(--text)',
              textAlign: 'left',
            }}
            onClick={() => navigate(`../drafts/${draft.id}`)}
          >
            <span className="ellipsis">{draft.title}</span>
            <span style={{ fontSize: 11, color: 'var(--text-dim)', flex: '0 0 auto' }}>Открыть →</span>
          </button>
        ))}
      </div>
    </Card>
  );
}

function CorrectionContext({ agentId, target, messageId }: { agentId: string; target: CorrectionTarget; messageId: string | null }) {
  const preview = useApi((signal) => api.previewResponseFeedback(agentId, correctionSource(target), signal),
    [agentId, target.kind, target.kind === 'sandbox' ? target.sessionId : target.conversationId,
      target.kind === 'sandbox' ? target.turnId : target.replyId]);
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
      <VerifiedSources preview={preview} />
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
    <VerifiedSources preview={preview} />
  </Card>;
}

function VerifiedSources({ preview }: { preview: ReturnType<typeof useApi<import('@rakurs/contract').CoachSourceSnapshot>> }) {
  if (preview.error) return <p role="alert">Не удалось проверить источники. Обновите страницу перед отправкой исправления.</p>;
  if (!preview.data) return <p>Проверяем источники ответа…</p>;
  return preview.data.sourceRecords.length
    ? <ul>{preview.data.sourceRecords.map((source) => <li key={source.id}>{source.title}: {source.content}</li>)}</ul>
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
