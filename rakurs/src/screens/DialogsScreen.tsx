import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type FormEvent,
} from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import * as api from '@/api';
import { HistoryImportPanel } from '@/components/knowledge/HistoryImportPanel';
import { AiSwitch } from '@/components/lead/AiSwitch';
import { LeadPanel } from '@/components/lead/LeadPanel';
import { Card } from '@/components/ui/primitives';
import { Async, EmptyState, Skeleton } from '@/components/ui/states';
import { useToast } from '@/components/ui/Toast';
import { usePollingApi } from '@/hooks/usePollingApi';
import { useAgent } from '@/store/agent';
import type { ConversationSummary, ConversationThread, Message, Role } from '@/types';

const time = (iso: string) =>
  new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

const bubble = (mine: boolean): CSSProperties => ({
  alignSelf: mine ? 'flex-end' : 'flex-start',
  maxWidth: '70%',
  padding: '9px 12px',
  borderRadius: 12,
  background: mine ? 'rgba(13,150,104,0.14)' : 'var(--sunken)',
  border: '1px solid var(--line-soft)',
});

/**
 * Whether «Так нельзя» belongs on this message: only the agent's own answer, and only for
 * the owner. «Обучение» refuses everyone else on the server (see `CoachScreen`'s own
 * comment), so a member offered this button would only ever land on a screen that tells
 * them so — worse than a button that is not there at all.
 */
export function canCoachFrom(message: Message, role: Role): boolean {
  return role === 'owner' && message.direction === 'out' && message.author === 'ai';
}

/**
 * Where «Так нельзя» sends the owner: «Обучение», with this dialog's id in the query string
 * so the coach can load its transcript, and — when the clicked message carries one — the
 * exact `ai_replies` id it came from, so the coach names *that* turn instead of falling back
 * to the conversation's latest reply (which need not be the one the owner is complaining
 * about at all). Both are ids, never the message itself — the fence
 * `server/src/lib/ai/coach.ts` builds around a transcript is not something a link built here
 * may hand a way around.
 */
export function coachLink(conversationId: string, aiReplyId?: string | null): string {
  const reply = aiReplyId ? `&reply=${aiReplyId}` : '';
  return `../coach?conversation=${conversationId}${reply}`;
}

export function DialogsScreen() {
  const { agent, role } = useAgent();
  // The selected conversation lives in the URL, so a card on the board opens its thread.
  const [params, setParams] = useSearchParams();
  const selected = params.get('conversation');
  const targetMessageId = params.get('message');
  const select = (conversationId: string) =>
    setParams({ conversation: conversationId }, { replace: true });

  const list = usePollingApi<ConversationSummary[]>(
    (signal) => api.listConversations(agent.id, signal),
    [agent.id],
  );

  // The same switch lives above the messages and in the lead card. Bumping this remounts
  // the card, which refetches the lead — otherwise the two would disagree until something
  // else reloaded the panel.
  const [aiNonce, setAiNonce] = useState(0);

  return (
    <>
      <div style={{ marginBottom: 16 }}>
        <HistoryImportPanel agentId={agent.id} readOnly={role !== 'owner'} />
      </div>
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <div style={{ width: 320, maxWidth: '100%', flex: '1 1 280px', minWidth: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
          <button type="button" className="btn-sm" onClick={list.reload} disabled={list.refreshing}>
            {list.refreshing && list.data !== undefined ? 'Обновляем…' : 'Обновить список'}
          </button>
        </div>
        {list.error !== undefined && list.data !== undefined && <div role="alert" style={{ color: 'var(--danger)', fontSize: 12, marginBottom: 8 }}>
          Не удалось обновить список: {api.humanError(list.error)}
        </div>}
        <Async state={list} skeleton={<Skeleton height={220} />}>
          {(conversations) =>
            conversations.length === 0 ? (
              <Card>
                <EmptyState>
                  Переписок пока нет. Они появятся, как только клиент напишет на подключённый
                  номер.
                </EmptyState>
              </Card>
            ) : (
              <Card pad={false}>
                {conversations.map((conversation) => (
                  <button
                    key={conversation.id}
                    type="button"
                    onClick={() => select(conversation.id)}
                    style={{
                      display: 'block',
                      width: '100%',
                      textAlign: 'left',
                      padding: '11px 14px',
                      border: 0,
                      borderBottom: '1px solid var(--line-soft)',
                      background:
                        conversation.id === selected ? 'rgba(13,150,104,0.10)' : 'transparent',
                      font: 'inherit',
                      cursor: 'pointer',
                      color: 'inherit',
                    }}
                  >
                    <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                      <span className="ellipsis" style={{ fontSize: 13.5, fontWeight: 600 }}>
                        {conversation.contactName ?? conversation.contactPhone}
                      </span>
                      <span
                        style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-dim)' }}
                      >
                        {conversation.lastMessageAt ? time(conversation.lastMessageAt) : ''}
                      </span>
                    </div>
                    <div
                      className="ellipsis"
                      style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 3 }}
                    >
                      {conversation.preview ?? 'Вложение'}
                    </div>
                    {conversation.adHeadline && (
                      <div style={{ fontSize: 11, color: 'var(--accent)', marginTop: 3 }}>
                        Из рекламы: {conversation.adHeadline}
                      </div>
                    )}
                  </button>
                ))}
              </Card>
            )
          }
        </Async>
      </div>

      <div style={{ flex: '999 1 420px', minWidth: 0, maxWidth: '100%' }}>
        {selected === null ? (
          <Card>
            <EmptyState>Выберите переписку слева.</EmptyState>
          </Card>
        ) : (
          <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div style={{ flex: '999 1 360px', minWidth: 0, maxWidth: '100%' }}>
              {/* `key={selected}` forces a remount on every conversation switch: a new
                  conversation is a new subject, and neither the loaded thread nor the
                  composer's draft belongs to the previous one. Without it `Thread` would
                  keep the old messages on screen until the new fetch resolves, and any
                  text left in the composer would still be sitting there, ready to be sent
                  to the wrong person. */}
              <Thread
                key={`${selected}:${targetMessageId ?? ''}`}
                agentId={agent.id}
                conversationId={selected}
                targetMessageId={targetMessageId}
                onSent={list.reload}
                onAiChanged={() => setAiNonce((n) => n + 1)}
              />
            </div>
            <div style={{ width: 300, maxWidth: '100%', flex: '1 1 280px', minWidth: 0 }}>
              {/* The same key for the same reason: another client's card must not flash
                  on screen under the wrong name. */}
              <LeadPanel
                key={`${selected}:${aiNonce}`}
                agentId={agent.id}
                conversationId={selected}
                onChanged={list.reload}
              />
            </div>
          </div>
        )}
      </div>
      </div>
    </>
  );
}

function Thread({
  agentId,
  conversationId,
  targetMessageId,
  onSent,
  onAiChanged,
}: {
  agentId: string;
  conversationId: string;
  targetMessageId: string | null;
  onSent: () => void;
  onAiChanged: () => void;
}) {
  const toast = useToast();
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  // What the switch was last told by the server, if it has been flipped since the thread
  // loaded. Null means nobody has touched it and the loaded thread still speaks for it.
  const [ai, setAi] = useState<boolean | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const messageList = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const initialScrollDone = useRef(false);
  const scrolledTarget = useRef<string | null>(null);

  const thread = usePollingApi<ConversationThread>(
    (signal) => api.getConversation(agentId, conversationId, signal),
    [agentId, conversationId],
  );

  // A source link names an exact stored message; ordinary opens start at the end. Background
  // refreshes only follow new messages when the operator was already near the bottom.
  useEffect(() => {
    const target = targetMessageId && scrolledTarget.current !== targetMessageId
      ? document.getElementById(`message-${targetMessageId}`)
      : null;
    if (target) {
      target.scrollIntoView({ block: 'center' });
      target.focus({ preventScroll: true });
      scrolledTarget.current = targetMessageId;
      initialScrollDone.current = true;
    } else if (!initialScrollDone.current || stickToBottom.current) {
      bottom.current?.scrollIntoView();
      initialScrollDone.current = true;
    }
  }, [thread.data, targetMessageId]);

  async function attach(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Cleared immediately: choosing the same file twice in a row must fire the change
    // event both times, and it only does if the input does not still hold it.
    event.target.value = '';
    if (!file) return;

    setSending(true);
    try {
      await api.sendFile(agentId, conversationId, file, draft);
      setDraft('');
      thread.reload();
      onSent();
    } catch (error) {
      toast.fail(error);
    } finally {
      setSending(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft.trim()) return;

    setSending(true);
    try {
      await api.sendMessage(agentId, conversationId, draft);
      setDraft('');
      thread.reload();
      onSent();
    } catch (error) {
      // The draft stays in the box. Retyping a message the network lost is the last
      // thing anyone wants to do.
      toast.fail(error);
    } finally {
      setSending(false);
    }
  }

  return (
    <Async state={thread} skeleton={<Skeleton height={420} />}>
      {(data) => (
        <Card>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13.5, fontWeight: 650 }}>
                {data.contactName ?? data.contactPhone}
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--text-dim)', marginTop: 2 }}>
                {data.contactPhone}
                {data.adHeadline ? ` · из рекламы «${data.adHeadline}»` : ''}
              </div>
            </div>
            {/* Over the messages, where an operator reading a reply they dislike already
                is. The lead card carries the same switch for whoever is looking there. */}
            <AiSwitch
              compact
              agentId={agentId}
              conversationId={conversationId}
              on={ai ?? data.aiEnabled}
              onSet={(aiEnabled) => {
                setAi(aiEnabled);
                onAiChanged();
              }}
              onFailed={thread.reload}
            />
          </div>

          <div
            ref={messageList}
            onScroll={() => {
              const element = messageList.current;
              if (!element) return;
              stickToBottom.current =
                element.scrollHeight - element.scrollTop - element.clientHeight < 48;
            }}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              margin: '14px 0',
              maxHeight: 460,
              overflowY: 'auto',
            }}
          >
            {data.messages.map((message) => (
              <Bubble
                key={message.id}
                agentId={agentId}
                conversationId={conversationId}
                message={message}
              />
            ))}
            <div ref={bottom} />
          </div>

          {data.windowOpen ? (
            <form onSubmit={submit} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Ответить"
                style={{
                  flex: 1,
                  minWidth: 140,
                  padding: '10px 12px',
                  background: 'var(--sunken)',
                  color: 'var(--text)',
                  border: '1px solid var(--line)',
                  borderRadius: 8,
                  font: 'inherit',
                  outline: 'none',
                }}
              />
              {/* A caption if the box has text, a bare file if it does not. */}
              <label
                className="btn"
                style={{ cursor: sending ? 'default' : 'pointer', opacity: sending ? 0.6 : 1 }}
                title="Отправить файл"
              >
                Файл
                <input
                  type="file"
                  hidden
                  disabled={sending}
                  onChange={(event) => void attach(event)}
                />
              </label>
              <button type="submit" className="btn" disabled={sending || !draft.trim()}>
                {sending ? 'Отправляем…' : 'Отправить'}
              </button>
            </form>
          ) : (
            /* Said plainly rather than shown as a dead button: WhatsApp closes the window
               24 hours after the client's last message, and nothing we do reopens it. */
            <div style={{ fontSize: 12.5, color: 'var(--text-dim)' }}>
              Прошло больше суток с последнего сообщения клиента. Написать первым можно только
              шаблоном — они появятся позже.
            </div>
          )}
        </Card>
      )}
    </Async>
  );
}

function Bubble({
  agentId,
  conversationId,
  message,
}: {
  agentId: string;
  conversationId: string;
  message: Message;
}) {
  const mine = message.direction === 'out';
  const { role } = useAgent();
  const navigate = useNavigate();
  const toast = useToast();
  const [addingCase, setAddingCase] = useState(false);

  /**
   * Copies the conversation's customer side into a saved test case — the same route
   * `test-cases.ts`'s own file comment describes, and the same owner-only standing «Так
   * нельзя» already has. Placed on the same message rather than once per conversation: the
   * two buttons answer the same question — «this dialog is worth learning from» — one by
   * teaching the agent directly, the other by keeping the dialog as a check a future draft
   * has to pass.
   */
  async function addCase() {
    if (addingCase) return;
    setAddingCase(true);
    try {
      await api.createCaseFromDialog(agentId, conversationId);
      toast.ok('Диалог сохранён как проверка');
    } catch (error) {
      toast.fail(error);
    } finally {
      setAddingCase(false);
    }
  }

  return (
    <div id={`message-${message.id}`} tabIndex={-1} style={bubble(mine)}>
      {/* A file from imported history is downloaded by the server on this very request, so
          the first open of an old photo takes a moment longer than the rest. */}
      {message.hasMedia && message.mediaMime?.startsWith('image/') && (
        <img
          src={api.mediaUrl(agentId, message.id)}
          alt=""
          style={{ maxWidth: '100%', borderRadius: 8, display: 'block', marginBottom: 6 }}
        />
      )}
      {message.hasMedia && message.mediaMime?.startsWith('audio/') && (
        // Голосовые — половина переписки продавца, и ссылка «Файл» вместо плеера означает
        // скачать файл, открыть его в другой программе и потерять место в диалоге.
        <audio
          controls
          preload="none"
          src={api.mediaUrl(agentId, message.id)}
          style={{ display: 'block', width: '100%', marginBottom: 6 }}
        />
      )}
      {message.hasMedia && message.mediaMime?.startsWith('video/') && (
        <video
          controls
          preload="metadata"
          src={api.mediaUrl(agentId, message.id)}
          style={{ maxWidth: '100%', borderRadius: 8, display: 'block', marginBottom: 6 }}
        />
      )}
      {message.hasMedia &&
        !message.mediaMime?.startsWith('image/') &&
        !message.mediaMime?.startsWith('audio/') &&
        !message.mediaMime?.startsWith('video/') && (
          <a href={api.mediaUrl(agentId, message.id)} style={{ fontSize: 12.5 }}>
            Файл
          </a>
        )}
      {message.body && <div style={{ fontSize: 13.5 }}>{message.body}</div>}
      {!message.body && !message.hasMedia && (
        <div style={{ fontSize: 12.5, color: 'var(--text-dim)' }}>
          Сообщение типа «{message.kind}» — показать его пока нечем.
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
        <div style={{ fontSize: 10.5, color: 'var(--text-dim)' }}>
          {time(message.sentAt)}
          {mine
            ? ` · ${message.author === 'ai' ? 'ИИ' : message.author === 'phone' ? 'с телефона' : 'оператор'}`
            : ''}
          {message.status ? ` · ${message.status}` : ''}
        </div>
        {canCoachFrom(message, role) && (
          <>
            <button
              type="button"
              onClick={() => navigate(coachLink(conversationId, message.aiReplyId))}
              style={{
                marginLeft: 'auto',
                fontSize: 10.5,
                color: 'var(--danger)',
                background: 'none',
                border: 0,
                padding: 0,
                cursor: 'pointer',
                textDecoration: 'underline',
              }}
            >
              Так нельзя
            </button>
            <button
              type="button"
              disabled={addingCase}
              onClick={() => void addCase()}
              style={{
                fontSize: 10.5,
                color: 'var(--text-dim)',
                background: 'none',
                border: 0,
                padding: 0,
                cursor: 'pointer',
                textDecoration: 'underline',
              }}
            >
              {addingCase ? 'Добавляем…' : 'В проверки'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
