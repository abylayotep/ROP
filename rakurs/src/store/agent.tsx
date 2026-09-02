import { createContext, useContext, useState, type ReactNode } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import * as api from '@/api';
import { ErrorState } from '@/components/ui/states';
import { useApi } from '@/hooks/useApi';
import { useAuth } from '@/store/auth';
import type { Agent, Role } from '@/types';

/**
 * The agent the URL points at, loaded once for the whole /a/:agentId subtree.
 *
 * Every section below needs the same row — its name for the header, its timezone for
 * dates — and loading it per screen would mean the same request four times on one page.
 */

interface AgentContextValue {
  agent: Agent;
  /** The signed-in person's role in this agent's account. */
  role: Role;
  reload: () => void;
  /** Swap in the row a mutation returned, without a round trip. */
  replace: (agent: Agent) => void;
}

const AgentContext = createContext<AgentContextValue | null>(null);

export function AgentProvider({ children }: { children: ReactNode }) {
  const { agentId } = useParams<{ agentId: string }>();
  const { state } = useAuth();
  const [local, setLocal] = useState<Agent | null>(null);

  const query = useApi<Agent>((signal) => api.getAgent(agentId!, signal), [agentId]);
  const agent = local?.id === agentId ? local : query.data;

  // `agent` is `Agent | null | undefined`: null when local hasn't taken over yet and the
  // query hasn't resolved, undefined once the request has failed with nothing cached.
  if (query.error !== undefined && agent == null) {
    // A stranger's agent answers 404 with «Агент не найден», which is exactly what the
    // person should read: not "forbidden", which would confirm it exists.
    return <ErrorState error={query.error} onRetry={query.reload} />;
  }
  if (agent == null) {
    return <div style={{ minHeight: '100vh', background: 'var(--page)' }} />;
  }

  const account =
    state.status === 'authenticated'
      ? state.user.accounts.find((a) => a.id === agent.accountId)
      : undefined;

  // The account list comes from the same session that just loaded the agent, so a
  // missing entry means the two disagree — send the person back to choose again.
  if (!account) return <Navigate to="/" replace />;

  return (
    <AgentContext.Provider
      value={{ agent, role: account.role, reload: query.reload, replace: setLocal }}
    >
      {children}
    </AgentContext.Provider>
  );
}

export function useAgent(): AgentContextValue {
  const ctx = useContext(AgentContext);
  if (!ctx) throw new Error('useAgent вызван вне AgentProvider');
  return ctx;
}
