# Task 11: The dialogs screen

Part of [WhatsApp Cloud API](2026-09-02-whatsapp-cloud-api.md).

Where the work actually happens: the list of conversations on the left, the thread on the right,
and a composer that says why it is disabled instead of failing when it is used.

**Files:**
- Create: `rakurs/src/screens/DialogsScreen.tsx`
- Modify: `rakurs/src/api/index.ts`, `rakurs/src/App.tsx`, `rakurs/src/lib/sections.ts`

**Interfaces:**
- Consumes: contract types `ConversationSummary`, `ConversationThread`, `Message` from task 9;
  `useAgent()`, `useApi`, `useToast`, `Async`, `Card`, `EmptyState`, `Skeleton`.
- Produces: nothing later tasks depend on.

---

- [ ] **Step 1: Add the calls**

In `rakurs/src/api/index.ts`:

```ts
// ── Диалоги ──────────────────────────────────────────────────────────────────

export const listConversations = (agentId: string, signal?: AbortSignal) =>
  request<ConversationSummary[]>(`/agents/${agentId}/conversations`, { signal });

export const getConversation = (agentId: string, conversationId: string, signal?: AbortSignal) =>
  request<ConversationThread>(`/agents/${agentId}/conversations/${conversationId}`, { signal });

export const sendMessage = (agentId: string, conversationId: string, body: string) =>
  request<Message>(`/agents/${agentId}/conversations/${conversationId}/messages`, {
    method: 'POST',
    body: { body },
  });

/** The address of a file inside a message. Access is checked by the session cookie. */
export const mediaUrl = (agentId: string, messageId: string) =>
  `${API_URL}/agents/${agentId}/messages/${messageId}/media`;
```

Extend the type import with `ConversationSummary`, `ConversationThread` and `Message`, and
import `API_URL` from `./client` so `mediaUrl` can build an address the browser can fetch with
the session cookie attached.

- [ ] **Step 2: Write the screen**

Create `rakurs/src/screens/DialogsScreen.tsx` — the screens directory is flat, there is no
`sections/` subdirectory:

```tsx
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
          /* Keyed by the conversation so switching remounts: the composer's draft belongs
             to the conversation it was typed in, and `useApi` keeps its previous data
             until a new fetch resolves. Without this, text written for one client can be
             sent to another. */
          <Thread
            key={selected}
            agentId={agent.id}
            conversationId={selected}
            onSent={list.reload}
          />
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
```

- [ ] **Step 3: Route the section to it**

In `rakurs/src/App.tsx`, render `DialogsScreen` for the `dialogs` path, and in
`rakurs/src/lib/sections.ts` set that entry's `pending` to `''`. Four sections still say which
stage brings them: Заказы, База знаний, Агент, Статистика.

- [ ] **Step 4: Check the gates**

```bash
npm --prefix rakurs run typecheck
npm --prefix rakurs run build
```

Expected: PASS.

- [ ] **Step 5: Look at it with real rows**

Insert a conversation and two messages straight into the development database, or replay a
signed webhook payload against a locally running server, then open Диалоги: the list shows the
client, the thread shows both messages in order, and the composer is enabled. Set
`last_inbound_at` back by two days and reload — the composer is replaced by the explanation.

- [ ] **Step 6: Commit**

```bash
git add -A rakurs
git commit -m "Show WhatsApp conversations and answer them from the cabinet"
```
