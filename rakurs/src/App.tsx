import { Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { AgentsScreen } from '@/screens/AgentsScreen';
import { LoginScreen } from '@/screens/LoginScreen';
import { AgentProvider, useAgent } from '@/store/agent';
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
