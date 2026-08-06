import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { getMe, login as apiLogin, logout as apiLogout, type AuthUser } from '@/api';

type AuthState =
  | { status: 'loading' }
  | { status: 'anonymous' }
  | { status: 'authenticated'; user: AuthUser };

interface AuthContextValue {
  state: AuthState;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' });

  useEffect(() => {
    let alive = true;
    getMe()
      .then((user) => {
        if (alive) setState({ status: 'authenticated', user });
      })
      .catch(() => {
        if (alive) setState({ status: 'anonymous' });
      });
    return () => {
      alive = false;
    };
  }, []);

  // Транспорт бросает это событие на любой 401 — сессия истекла посреди работы.
  useEffect(() => {
    const onUnauthorized = () => setState({ status: 'anonymous' });
    window.addEventListener('rakurs:unauthorized', onUnauthorized);
    return () => window.removeEventListener('rakurs:unauthorized', onUnauthorized);
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    setState({ status: 'authenticated', user: await apiLogin(email, password) });
  }, []);

  const signOut = useCallback(async () => {
    // Выход на клиенте не должен зависеть от того, дошёл ли запрос.
    await apiLogout().catch(() => undefined);
    setState({ status: 'anonymous' });
  }, []);

  const value = useMemo(() => ({ state, signIn, signOut }), [state, signIn, signOut]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}
