import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type FormEvent,
} from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import * as api from '@/api';
import { AiSwitch } from '@/components/lead/AiSwitch';
import { LeadPanel } from '@/components/lead/LeadPanel';
import { Card } from '@/components/ui/primitives';
import { Async, EmptyState, Skeleton } from '@/components/ui/states';
import { useToast } from '@/components/ui/Toast';
import { usePollingApi } from '@/hooks/usePollingApi';
import { useDebounced } from '@/hooks/useApi';
import { formatPhone } from '@/lib/phone';
import { useAgent } from '@/store/agent';
import { CONVERSATION_PAGE_SIZE, MESSAGE_PAGE_SIZE, messageWindow } from './dialog-window';
import type { ConversationSummary, ConversationThread, Message, Role } from '@/types';

const dateFormatter = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
});
const time = (iso: string) => dateFormatter.format(new Date(iso));

function contactIdentity(contact: Pick<ConversationSummary, 'channel' | 'contactAddress' | 'contactName' | 'contactPhone'>) {
  if (contact.channel === 'instagram') {
    const value = contact.contactAddress;
    return value.startsWith('@') ? value : `@${value}`;
  }
  return formatPhone(contact.contactPhone);
}

export const supportsFileSending = (channel: ConversationSummary['channel']) => channel === 'whatsapp';

export const closedReplyMessage = (channel: ConversationSummary['channel']) => channel === 'instagram'
  ? 'Окно ответа Instagram закрыто: прошло больше суток с последнего сообщения клиента.'
  : 'Прошло больше суток с последнего сообщения клиента. Написать первым можно только шаблоном — они появятся позже.';

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
export function coachLink(conversationId: string, aiReplyId?: string | null, messageId?: string): string {
  const reply = aiReplyId ? `&reply=${aiReplyId}` : '';
  const message = messageId ? `&message=${messageId}` : '';
  return `../coach?conversation=${conversationId}${reply}${message}`;
}

export function DialogsScreen() {
  const { agent } = useAgent();
  // The selected conversation lives in the URL, so a card on the board opens its thread.
  const [params, setParams] = useSearchParams();
  const selected = params.get('conversation');
  const targetMessageId = params.get('message');
  const select = (conversationId: string) =>
    setParams({ conversation: conversationId }, { replace: true });

  const [conversationStart, setConversationStart] = useState(0);
  const [query, setQuery] = useState('');
  const search = useDebounced(query).trim();
  const list = usePollingApi<ConversationSummary[]>(
    (signal) => api.listConversations(agent.id, signal, {
      limit: CONVERSATION_PAGE_SIZE + 1, offset: conversationStart, q: search || undefined,
    }),
    [agent.id, conversationStart, search],
  );

  // The same switch lives above the messages and in the lead card. Bumping this remounts
  // the card, which refetches the lead — otherwise the two would disagree until something
  // else reloaded the panel.
  const [aiNonce, setAiNonce] = useState(0);
  useEffect(() => setConversationStart(0), [agent.id, search]);

  return (
    <>
      <div style={{ marginBottom: 16, fontSize: 12, color: 'var(--text-dim)' }}>
        Новые сообщения обновляются автоматически каждые 5 секунд, пока вкладка открыта.
        {' '}Загрузка истории, создание базы и скрипта — в разделе{' '}
        <Link to={`/a/${agent.id}/knowledge`}>База знаний</Link>.
      </div>
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <div style={{ width: 320, maxWidth: '100%', flex: '1 1 280px', minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <label className="funnel-search" style={{ flex: 1, width: 'auto' }}>
            <span aria-hidden="true">⌕</span>
            <input type="search" aria-label="Поиск диалогов" placeholder="Имя, телефон или Instagram" value={query} onChange={(event) => setQuery(event.target.value)} />
            {query && <button type="button" aria-label="Очистить поиск" onClick={() => setQuery('')}>×</button>}
          </label>
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
                  {search ? 'Диалогов с таким номером не найдено.' : 'Переписок пока нет. Они появятся, как только клиент напишет на подключённый номер.'}
                </EmptyState>
              </Card>
            ) : (
              <Card pad={false}>
                {conversations.slice(0, CONVERSATION_PAGE_SIZE).map((conversation) => (
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
                        {contactIdentity(conversation)}
                      </span>
                      <span style={{ fontSize: 10.5, color: 'var(--text-dim)' }}>
                        {conversation.channel === 'instagram' ? 'Instagram' : 'WhatsApp'}
                      </span>
                      <span
                        style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-dim)' }}
                      >
                        {conversation.lastMessageAt ? time(conversation.lastMessageAt) : ''}
                      </span>
                    </div>
                    {conversation.channel === 'instagram' && conversation.contactName && conversation.contactName !== conversation.contactAddress && (
                      <div className="ellipsis" style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>{conversation.contactName}</div>
                    )}
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
                <div style={{ display: 'flex', gap: 8, padding: 12, flexWrap: 'wrap' }}>
                  {conversationStart > 0 && <button type="button" className="btn-sm"
                    onClick={() => setConversationStart((start) => Math.max(0, start - CONVERSATION_PAGE_SIZE))}>
                    Предыдущие диалоги
                  </button>}
                  {CONVERSATION_PAGE_SIZE < conversations.length && <button
                    type="button" className="btn-sm"
                    onClick={() => setConversationStart((start) => start + CONVERSATION_PAGE_SIZE)}>
                    Следующие диалоги
                  </button>}
                </div>
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
              <ConversationThreadView
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

export function ConversationThreadView({
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
  const [pageStart, setPageStart] = useState<number | null>(null);
  const [followLatest, setFollowLatest] = useState(false);
  const [cursor, setCursor] = useState<{ before?: string; after?: string; around?: string }>(
    targetMessageId ? { around: targetMessageId } : {},
  );
  // What the switch was last told by the server, if it has been flipped since the thread
  // loaded. Null means nobody has touched it and the loaded thread still speaks for it.
  const [ai, setAi] = useState<boolean | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const messageList = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const initialScrollDone = useRef(false);
  const scrolledTarget = useRef<string | null>(null);

  const thread = usePollingApi<ConversationThread>(
    (signal) => api.getConversation(agentId, conversationId, signal, {
      limit: MESSAGE_PAGE_SIZE, ...cursor,
    }),
    [agentId, conversationId, cursor],
  );

  const page = useMemo(() => messageWindow(
    thread.data?.messages ?? [], pageStart, followLatest ? null : targetMessageId,
  ), [thread.data?.messages, pageStart, followLatest, targetMessageId]);

  const wasLoading = useRef(true);
  useEffect(() => {
    if (wasLoading.current && !thread.loading && pageStart !== null && messageList.current) {
      messageList.current.scrollTop = 0;
    }
    wasLoading.current = thread.loading;
  }, [thread.loading, pageStart]);

  // A source link names an exact stored message; ordinary opens start at the end. Background
  // refreshes only follow new messages when the operator was already near the bottom.
  useEffect(() => {
    if (pageStart !== null) return;
    const target = !followLatest && targetMessageId && scrolledTarget.current !== targetMessageId
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
  }, [thread.data, targetMessageId, pageStart, followLatest]);

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
                {contactIdentity(data)}
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--text-dim)', marginTop: 2 }}>
                {data.channel === 'instagram' ? 'Instagram Direct' : 'WhatsApp'}
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--text-dim)', marginTop: 2 }}>
                {data.adHeadline ? `Из рекламы «${data.adHeadline}»` : ''}
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
            {(data.hasOlder ?? page.start > 0) && <button type="button" className="btn-sm"
              onClick={() => {
                if (data.hasOlder !== undefined) {
                  setPageStart(0);
                  setCursor({ before: data.messages[0]?.id });
                } else setPageStart(Math.max(0, page.start - MESSAGE_PAGE_SIZE));
              }}>
              Предыдущие сообщения
            </button>}
            {data.messages.slice(page.start, page.end).map((message) => (
              <Bubble
                key={message.id}
                agentId={agentId}
                conversationId={conversationId}
                message={message}
              />
            ))}
            {(data.hasNewer ?? page.end < data.messages.length) && <button type="button" className="btn-sm"
              onClick={() => {
                if (data.hasNewer !== undefined) {
                  setPageStart(0);
                  setCursor({ after: data.messages[data.messages.length - 1]?.id });
                } else setPageStart(page.end);
              }}>
              Следующие сообщения
            </button>}
            {(pageStart !== null || data.hasNewer || page.end < data.messages.length) && <button
              type="button" className="btn-sm" onClick={() => {
                stickToBottom.current = true;
                setFollowLatest(true);
                setPageStart(null);
                setCursor({});
              }}>
              К последним сообщениям
            </button>}
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
              {!supportsFileSending(data.channel) ? (
                <button className="btn" type="button" disabled title="Instagram Direct пока поддерживает только текст">
                  Только текст
                </button>
              ) : (
                <label className="btn" style={{ cursor: sending ? 'default' : 'pointer', opacity: sending ? 0.6 : 1 }} title="Отправить файл">
                  Файл
                  <input type="file" hidden disabled={sending} onChange={(event) => void attach(event)} />
                </label>
              )}
              <button type="submit" className="btn" disabled={sending || !draft.trim()}>
                {sending ? 'Отправляем…' : 'Отправить'}
              </button>
            </form>
          ) : (
            /* Said plainly rather than shown as a dead button: WhatsApp closes the window
               24 hours after the client's last message, and nothing we do reopens it. */
            <div style={{ fontSize: 12.5, color: 'var(--text-dim)' }}>
              {closedReplyMessage(data.channel)}
            </div>
          )}
        </Card>
      )}
    </Async>
  );
}

const Bubble = memo(function Bubble({
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
          loading="lazy"
          decoding="async"
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
          preload="none"
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
            {message.aiReplyId && <button type="button"
              onClick={() => navigate(coachLink(conversationId, message.aiReplyId, message.id))}
              style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--danger)', background: 'none', border: 0, padding: 0, cursor: 'pointer', textDecoration: 'underline' }}>
              Исправить ответ
            </button>}
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
});
