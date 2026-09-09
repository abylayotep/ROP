import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import * as api from '@/api';
import { ProposalCard } from '@/components/coach/ProposalCard';
import { RuleList } from '@/components/coach/RuleList';
import { Card } from '@/components/ui/primitives';
import { Async, EmptyState, Skeleton } from '@/components/ui/states';
import { useToast } from '@/components/ui/Toast';
import { useApi } from '@/hooks/useApi';
import { useAgent } from '@/store/agent';
import type { AgentRule, CoachMessage, ConversationThread } from '@/types';

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
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  // The dialog «Так нельзя» was clicked from, if any. Read straight out of the URL rather
  // than copied into state on mount: `Coach` stays mounted (keyed on the agent, not on this
  // param) for as long as the owner stays on the screen, so a value copied once would go
  // stale the moment the owner detaches or the sidebar's own link — no query string at all —
  // brings them back here later. Reading the param itself means there is nothing to go stale.
  const [params, setParams] = useSearchParams();
  const conversationId = params.get('conversation');
  const detach = () => setParams({}, { replace: true });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'nearest' });
  }, [messages.length]);

  // Focuses the composer the moment a dialog gets attached — that is exactly when the owner
  // is meant to start typing their complaint, transcript already in hand.
  useEffect(() => {
    if (conversationId !== null) textRef.current?.focus();
  }, [conversationId]);

  async function send(event: FormEvent) {
    event.preventDefault();
    const value = text.trim();
    if (value === '' || sending) return;

    setSending(true);
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
      });
      setMessages((prev) => [
        ...prev,
        {
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
    } catch (error) {
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
                    <ProposalCard agentId={agentId} message={message} rules={rules} onRejected={onRejected} />
                  )}
                </div>
              ))
            )}
            <div ref={bottomRef} />
          </div>
        </Card>

        <form onSubmit={send} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <textarea
            ref={textRef}
            style={{ ...control, minHeight: 72 }}
            value={text}
            disabled={sending}
            placeholder="Например: мы продаём мебель на заказ, всегда спрашиваем город и срок"
            onChange={(e) => setText(e.target.value)}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button type="submit" className="btn" disabled={sending || text.trim() === ''}>
              {sending ? 'Коуч отвечает…' : 'Отправить'}
            </button>
            {/* Every turn is a real OpenRouter call, the same money a sandbox run spends —
                said next to the button that spends it, not buried in a tooltip. */}
            <span style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>
              Каждое сообщение коучу оплачивается с вашего счёта в OpenRouter.
            </span>
          </div>
        </form>
      </div>

      <div style={{ flex: '1 1 46%', minWidth: 340 }}>
        <RuleList agentId={agentId} rules={rules} onChanged={setRules} />
      </div>
    </div>
  );
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
