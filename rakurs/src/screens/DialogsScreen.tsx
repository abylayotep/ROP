import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import * as api from '@/api';
import { Card } from '@/components/ui/primitives';
import { Async, EmptyState, Skeleton } from '@/components/ui/states';
import { useToast } from '@/components/ui/Toast';
import { useApi } from '@/hooks/useApi';
import { useAgent } from '@/store/agent';
import type { ConversationSummary, ConversationThread, Message } from '@/types';

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

export function DialogsScreen() {
  const { agent } = useAgent();
  const [selected, setSelected] = useState<string | null>(null);

  const list = useApi<ConversationSummary[]>(
    (signal) => api.listConversations(agent.id, signal),
    [agent.id],
  );

  return (
    <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
      <div style={{ width: 320, flex: '0 0 320px' }}>
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
                    onClick={() => setSelected(conversation.id)}
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

      <div style={{ flex: 1, minWidth: 0 }}>
        {selected === null ? (
          <Card>
            <EmptyState>Выберите переписку слева.</EmptyState>
          </Card>
        ) : (
          <Thread agentId={agent.id} conversationId={selected} onSent={list.reload} />
        )}
      </div>
    </div>
  );
}

function Thread({
  agentId,
  conversationId,
  onSent,
}: {
  agentId: string;
  conversationId: string;
  onSent: () => void;
}) {
  const toast = useToast();
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  const thread = useApi<ConversationThread>(
    (signal) => api.getConversation(agentId, conversationId, signal),
    [agentId, conversationId],
  );

  // A conversation is read from the bottom: the newest message is the one being answered.
  useEffect(() => {
    bottom.current?.scrollIntoView();
  }, [thread.data]);

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
          <div style={{ fontSize: 13.5, fontWeight: 650 }}>
            {data.contactName ?? data.contactPhone}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--text-dim)', marginTop: 2 }}>
            {data.contactPhone}
            {data.adHeadline ? ` · из рекламы «${data.adHeadline}»` : ''}
          </div>

          <div
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
              <Bubble key={message.id} agentId={agentId} message={message} />
            ))}
            <div ref={bottom} />
          </div>

          {data.windowOpen ? (
            <form onSubmit={submit} style={{ display: 'flex', gap: 8 }}>
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Ответить"
                style={{
                  flex: 1,
                  padding: '10px 12px',
                  background: 'var(--sunken)',
                  color: 'var(--text)',
                  border: '1px solid var(--line)',
                  borderRadius: 8,
                  font: 'inherit',
                  outline: 'none',
                }}
              />
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

function Bubble({ agentId, message }: { agentId: string; message: Message }) {
  const mine = message.direction === 'out';

  return (
    <div style={bubble(mine)}>
      {message.hasMedia && message.mediaMime?.startsWith('image/') && (
        <img
          src={api.mediaUrl(agentId, message.id)}
          alt=""
          style={{ maxWidth: '100%', borderRadius: 8, display: 'block', marginBottom: 6 }}
        />
      )}
      {message.hasMedia && !message.mediaMime?.startsWith('image/') && (
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
      <div style={{ fontSize: 10.5, color: 'var(--text-dim)', marginTop: 4 }}>
        {time(message.sentAt)}
        {mine ? ` · ${message.author === 'ai' ? 'ИИ' : 'оператор'}` : ''}
        {message.status ? ` · ${message.status}` : ''}
      </div>
    </div>
  );
}
