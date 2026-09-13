import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Layout } from '@/components/layout/Layout';
import { LEGAL_PAGE_IDS } from '@/legal/content';
import { LegalPage } from '@/legal/LegalPage';
import { SECTIONS } from '@/lib/sections';
import { legacyCoachSearch, legacyKnowledgeSearch } from '@/lib/training-routes';
import { AgentScreen } from '@/screens/AgentScreen';
import { AgentSettingsScreen } from '@/screens/AgentSettingsScreen';
import { AgentsScreen } from '@/screens/AgentsScreen';
import { OrdersScreen } from '@/screens/OrdersScreen';
import { BoardScreen } from '@/screens/BoardScreen';
import { CustomersScreen } from '@/screens/CustomersScreen';
import { DraftScreen } from '@/screens/DraftScreen';
import { IntegrationsScreen } from '@/screens/IntegrationsScreen';
import { LoginScreen } from '@/screens/LoginScreen';
import { SectionScreen } from '@/screens/SectionScreen';
import { SetupScreen } from '@/screens/SetupScreen';
import { StatsScreen } from '@/screens/StatsScreen';
import { TestScreen } from '@/screens/TestScreen';
import { TrainingScreen } from '@/screens/TrainingScreen';
import { AgentProvider } from '@/store/agent';
import { AuthProvider, useAuth } from '@/store/auth';

export function App() {
  return (
    <AuthProvider>
      <Routes>
        {/* Public and outside the gate: Meta App Review and our businesses' customers open
            these without an account, and a signed-in user sees them without the app chrome. */}
        {LEGAL_PAGE_IDS.map((id) => (
          <Route key={id} path={`/${id}`} element={<LegalPage id={id} />} />
        ))}
        <Route path="*" element={<AuthGate />} />
      </Routes>
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
        <Route index element={<Navigate to="funnel" replace />} />
        {/* Not a section: reached only from `ProposalCard`'s «В черновик» or a draft link,
            never from the sidebar — `Sidebar` reads `SECTIONS`, and this route is not one. */}
        <Route path="drafts/:draftId" element={<DraftScreen />} />
        {SECTIONS.map((section) => (
          <Route
            key={section.path}
            path={section.path}
            element={
              section.path === 'setup' ? (
                <SetupScreen />
              ) : section.path === 'settings' ? (
                <AgentSettingsScreen />
              ) : section.path === 'integrations' ? (
                <IntegrationsScreen />
              ) : section.path === 'funnel' ? (
                <BoardScreen />
              ) : section.path === 'orders' ? (
                <OrdersScreen />
              ) : section.path === 'customers' ? (
                <CustomersScreen />
              ) : section.path === 'training' ? (
                <TrainingScreen />
              ) : section.path === 'testing' ? (
                <TestScreen />
              ) : section.path === 'agent' ? (
                <AgentScreen />
              ) : section.path === 'stats' ? (
                <StatsScreen />
              ) : (
                <SectionScreen section={section} />
              )
            }
          />
        ))}
        <Route path="dialogs" element={<LegacyDialogsRedirect />} />
        <Route path="knowledge" element={<LegacyTrainingRedirect map={legacyKnowledgeSearch} />} />
        <Route path="coach" element={<LegacyTrainingRedirect map={legacyCoachSearch} />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function LegacyDialogsRedirect() {
  const location = useLocation();
  return <Navigate to={`../funnel${location.search}`} replace />;
}

/** «База знаний» and «Обучение» merged into «Обучение агента»; old bookmarks and
 * notification links land on the matching tab with every other parameter kept. */
function LegacyTrainingRedirect({ map }: { map: (current: URLSearchParams) => URLSearchParams }) {
  const location = useLocation();
  return <Navigate to={`../training?${map(new URLSearchParams(location.search))}`} replace />;
}
