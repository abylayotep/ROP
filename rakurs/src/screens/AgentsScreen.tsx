import { Link, Navigate } from 'react-router-dom';
import * as api from '@/api';
import { Card } from '@/components/ui/primitives';
import { Async, EmptyState, Skeleton } from '@/components/ui/states';
import { useApi } from '@/hooks/useApi';
import { useAuth } from '@/store/auth';
import type { Account, Agent } from '@/types';

interface Group {
  account: Account;
  agents: Agent[];
}

export function AgentsScreen() {
  const { state, signOut } = useAuth();
  const accounts = state.status === 'authenticated' ? state.user.accounts : [];
  const key = accounts.map((a) => a.id).join(',');

  const query = useApi<Group[]>(
    async (signal) =>
      Promise.all(
        accounts.map(async (account) => ({
          account,
          agents: await api.listAgents(account.id, signal),
        })),
      ),
    [key],
  );

  // One company, one agent: the picker would be a page with a single button on it.
  const only = query.data?.length === 1 && query.data[0]!.agents.length === 1;
  if (only) return <Navigate to={`/a/${query.data![0]!.agents[0]!.id}/orders`} replace />;

  return (
    <div style={{ minHeight: '100vh', background: 'var(--page)', padding: '40px 26px' }}>
      <div style={{ maxWidth: 900, margin: '0 auto' }}>
        <header
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 16,
            marginBottom: 22,
          }}
        >
          <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Агенты</h1>
          <span style={{ fontSize: 12.5, color: 'var(--text-dim)' }}>
            Выберите, с кем работать
          </span>
          <button
            type="button"
            className="btn"
            style={{ marginLeft: 'auto' }}
            onClick={() => void signOut()}
          >
            Выйти
          </button>
        </header>

        <Async
          state={query}
          skeleton={<Skeleton height={92} />}
        >
          {(groups) => (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 26 }}>
              {groups.map(({ account, agents }) => (
                <section key={account.id}>
                  <div
                    style={{
                      fontSize: 11,
                      letterSpacing: '0.4px',
                      textTransform: 'uppercase',
                      color: 'var(--text-dim)',
                      marginBottom: 10,
                    }}
                  >
                    {account.name}
                  </div>

                  {agents.length === 0 ? (
                    <Card>
                      <EmptyState>
                        {account.role === 'owner'
                          ? 'Ни одного агента. Создайте первого — кнопка появится на этом экране.'
                          : 'В этой компании ещё нет агентов. Их создаёт владелец.'}
                      </EmptyState>
                    </Card>
                  ) : (
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
                        gap: 12,
                      }}
                    >
                      {agents.map((agent) => (
                        <Link
                          key={agent.id}
                          to={`/a/${agent.id}/orders`}
                          className="card card-pad"
                          style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}
                        >
                          <div style={{ fontSize: 14.5, fontWeight: 650 }}>{agent.name}</div>
                          <div
                            style={{
                              fontSize: 12,
                              color: 'var(--text-dim)',
                              marginTop: 6,
                              minHeight: 17,
                            }}
                          >
                            {agent.description}
                          </div>
                        </Link>
                      ))}
                    </div>
                  )}
                </section>
              ))}
            </div>
          )}
        </Async>
      </div>
    </div>
  );
}
