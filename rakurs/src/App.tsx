import { LoginScreen } from '@/screens/LoginScreen';
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

  // Task 6 replaces this with the agent picker and the /a/:agentId routes.
  return (
    <div style={{ minHeight: '100vh', background: 'var(--page)', padding: 40 }}>
      Вход выполнен: {state.user.name}
    </div>
  );
}
