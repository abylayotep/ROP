import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from '@/components/layout/Layout';
import { AgentScreen } from '@/screens/AgentScreen';
import { BroadcastScreen } from '@/screens/BroadcastScreen';
import { CreativesScreen } from '@/screens/CreativesScreen';
import { DialogsScreen } from '@/screens/DialogsScreen';
import { OverviewScreen } from '@/screens/OverviewScreen';
import { SellersScreen } from '@/screens/SellersScreen';
import { SettingsScreen } from '@/screens/SettingsScreen';

export function App() {
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
