import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from '@/components/layout/Layout';
import { SECTIONS } from '@/lib/sections';
import { AgentsScreen } from '@/screens/AgentsScreen';
import { LoginScreen } from '@/screens/LoginScreen';
import { SectionScreen } from '@/screens/SectionScreen';
import { AgentProvider } from '@/store/agent';
import { AuthProvider, useAuth } from '@/store/auth';

export function App() {
  return (
    <AuthProvider>
      <AuthGate />
    </AuthProvider>
  );
}

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
            <Layout />
          </AgentProvider>
        }
      >
        <Route index element={<Navigate to="orders" replace />} />
        {SECTIONS.map((section) => (
          <Route
            key={section.path}
            path={section.path}
            element={<SectionScreen section={section} />}
          />
        ))}
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
