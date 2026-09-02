# Task 6: Agent picker and routing

Part of [Tenancy and Shell](2026-09-02-tenancy-and-shell.md).

Signing in lands on a list of the agents you may open, one group per account. Choosing one
enters `/a/:agentId/…`, where a provider loads that agent once for the whole subtree. A person
with a single agent never sees the picker: they are redirected straight in.

The section routes render a bare stub here. Task 7 puts the sidebar and the seven sections
around them.

**Files:**
- Create: `rakurs/src/store/agent.tsx`
- Create: `rakurs/src/screens/AgentsScreen.tsx`
- Modify: `rakurs/src/App.tsx`

**Interfaces:**
- Consumes: `getAgent`, `listAgents` from Task 5; `useAuth().state.user.accounts`.
- Produces: `useAgent(): { agent: Agent; role: Role; reload: () => void; replace: (agent: Agent) => void }`
  from `rakurs/src/store/agent.tsx`, and the route table in `App.tsx`.

---

- [ ] **Step 1: Write the agent provider**

Create `rakurs/src/store/agent.tsx`:

```tsx
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

  if (query.error !== undefined && agent === undefined) {
    // A stranger's agent answers 404 with «Агент не найден», which is exactly what the
    // person should read: not "forbidden", which would confirm it exists.
    return <ErrorState error={query.error} onRetry={query.reload} />;
  }
  if (agent === undefined) {
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
```

- [ ] **Step 2: Write the picker**

Create `rakurs/src/screens/AgentsScreen.tsx`:

```tsx
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
```

- [ ] **Step 3: Route the authenticated half of the app**

Replace the `AuthGate` return in `rakurs/src/App.tsx` (the placeholder from Task 5) so the
file reads:

```tsx
import { Navigate, Route, Routes } from 'react-router-dom';
import { AgentsScreen } from '@/screens/AgentsScreen';
import { LoginScreen } from '@/screens/LoginScreen';
import { AgentProvider } from '@/store/agent';
import { AuthProvider, useAuth } from '@/store/auth';

export function App() {
  return (
    <AuthProvider>
      <AuthGate />
    </AuthProvider>
  );
}

const SECTIONS = [
  'orders',
  'dialogs',
  'knowledge',
  'agent',
  'integrations',
  'stats',
  'settings',
] as const;

function AuthGate() {
  const { state } = useAuth();

  // Blank, not a spinner: the session check is one local request, and a 40 ms flash of
  // an indicator reads as a glitch.
  if (state.status === 'loading') {
    return <div style={{ minHeight: '100vh', background: 'var(--page)' }} />;
  }
  if (state.status === 'anonymous') return <LoginScreen />;

  return (
    <Routes>
      <Route path="/" element={<AgentsScreen />} />
      <Route
        path="/a/:agentId"
        element={
          <AgentProvider>
            <AgentShell />
          </AgentProvider>
        }
      >
        <Route index element={<Navigate to="orders" replace />} />
        {SECTIONS.map((section) => (
          <Route key={section} path={section} element={<Section name={section} />} />
        ))}
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
```

- [ ] **Step 4: Add the temporary shell and stub**

Still in `App.tsx`, below `AuthGate`, add the two components Task 7 replaces:

```tsx
import { Outlet } from 'react-router-dom';
import { useAgent } from '@/store/agent';

/** Task 7 replaces this with the sidebar, the header and the section screens. */
function AgentShell() {
  const { agent } = useAgent();
  return (
    <div style={{ minHeight: '100vh', background: 'var(--page)', padding: 26 }}>
      <div style={{ fontWeight: 700, marginBottom: 12 }}>{agent.name}</div>
      <Outlet />
    </div>
  );
}

function Section({ name }: { name: string }) {
  return <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>Раздел {name}</div>;
}
```

Merge the two `react-router-dom` imports into one line — `noUnusedLocals` is on and duplicate
import statements from the same module will not compile cleanly.

- [ ] **Step 5: Typecheck and build**

```bash
npm --prefix rakurs run typecheck
npm --prefix rakurs run build
```

Expected: PASS.

- [ ] **Step 6: Walk the routes in a browser**

With both dev servers running, sign in and check:

1. One account with one agent → the URL becomes `/a/<id>/orders` without showing the picker.
2. Create a second agent straight in the database to see the picker:
   ```bash
   docker compose -f deploy/compose.dev.yml exec -T db \
     psql -U rakurs -d rakurs_dev -c \
     "insert into agents (account_id, name, description) select id, 'Второй агент', 'Проверка списка' from accounts limit 1;"
   ```
   Reload `/` — two cards, the account name above them.
3. Open `/a/00000000-0000-0000-0000-000000000000/orders` → «Агент не найден» with a retry
   button, not a blank page and not a crash.

- [ ] **Step 7: Commit**

```bash
git add -A rakurs
git commit -m "Add the agent picker and the per-agent route subtree"
```
