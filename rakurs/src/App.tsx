import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from '@/components/layout/Layout';
import { AgentScreen } from '@/screens/AgentScreen';
import { BroadcastScreen } from '@/screens/BroadcastScreen';
import { CreativesScreen } from '@/screens/CreativesScreen';
import { DialogsScreen } from '@/screens/DialogsScreen';
import { LoginScreen } from '@/screens/LoginScreen';
import { OverviewScreen } from '@/screens/OverviewScreen';
import { SellersScreen } from '@/screens/SellersScreen';
import { SettingsScreen } from '@/screens/SettingsScreen';
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

  // Пусто, а не спиннер: проверка сессии — один локальный запрос, и мигание
  // индикатора на 40 мс читается как глюк.
  if (state.status === 'loading') {
    return <div style={{ minHeight: '100vh', background: 'var(--page)' }} />;
  }
  if (state.status === 'anonymous') return <LoginScreen />;

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Navigate to="/overview" replace />} />
        <Route path="/overview" element={<OverviewScreen />} />
        <Route path="/dialogs" element={<DialogsScreen />} />
        <Route path="/sellers" element={<SellersScreen />} />
        <Route path="/creatives" element={<CreativesScreen />} />
        <Route path="/broadcast" element={<BroadcastScreen />} />
        <Route path="/agent" element={<AgentScreen />} />
        <Route path="/settings" element={<SettingsScreen />} />
        <Route path="*" element={<Navigate to="/overview" replace />} />
      </Routes>
    </Layout>
  );
}
