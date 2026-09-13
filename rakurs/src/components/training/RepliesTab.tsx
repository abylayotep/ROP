import { useState } from 'react';
import * as api from '@/api';
import { RuleList } from '@/components/coach/RuleList';
import { CommunicationStyleCard } from '@/components/knowledge/CommunicationStyleCard';
import { ErrorState, Skeleton } from '@/components/ui/states';
import { useApi } from '@/hooks/useApi';
import type { AgentRule } from '@/types';

/**
 * «Как отвечает»: everything that shapes a live reply — the communication style and the rules.
 * A non-owner reads the style; the rules route is owner-only on the server, so the block that
 * calls it is not even mounted for anyone else.
 */
export function RepliesTab({ agentId, owner, onOpenCoach }: {
  agentId: string;
  owner: boolean;
  onOpenCoach: () => void;
}) {
  return (
    <div className="training-replies">
      <p className="training-tab__intro">
        {owner
          ? 'Стиль — манера речи. Правила — что агент обязан или не должен делать.'
          : 'Стиль — манера речи агента в ответах клиентам.'}
      </p>
      <CommunicationStyleCard agentId={agentId} readOnly={!owner} />
      {owner && <OwnerRules agentId={agentId} />}
      <p className="training-replies__note">Изменения действуют только на будущие ответы.</p>
      {owner && (
        <button type="button" className="btn" onClick={onOpenCoach}>
          Исправить конкретный ответ через тренера
        </button>
      )}
    </div>
  );
}

function OwnerRules({ agentId }: { agentId: string }) {
  const query = useApi<AgentRule[]>((signal) => api.listRules(agentId, signal), [agentId]);
  // `RuleList` reports every create, edit, toggle and reorder with the full new list; it
  // overrides the loaded one until the agent changes.
  const [changed, setChanged] = useState<{ agentId: string; rules: AgentRule[] } | null>(null);
  const rules = changed?.agentId === agentId ? changed.rules : query.data;

  if (rules === undefined) {
    return query.error !== undefined
      ? <ErrorState error={query.error} onRetry={query.reload} compact />
      : <Skeleton height={240} />;
  }
  return <RuleList agentId={agentId} rules={rules} onChanged={(next) => setChanged({ agentId, rules: next })} />;
}
