import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, HashRouter } from 'react-router-dom';
import { App } from './App';
import { ToastProvider } from '@/components/ui/Toast';
import { AppStateProvider } from '@/store/app-state';
import '@/styles/global.css';

// Однофайловая сборка открывается по file://, где обычные пути не работают —
// там маршрутизация идёт через хэш. На сервере остаётся BrowserRouter.
const Router = import.meta.env.VITE_HASH_ROUTER ? HashRouter : BrowserRouter;

const root = document.getElementById('root');
if (!root) throw new Error('Не найден #root');

createRoot(root).render(
  <StrictMode>
    <Router>
      <AppStateProvider>
        <ToastProvider>
          <App />
        </ToastProvider>
      </AppStateProvider>
    </Router>
  </StrictMode>
);
