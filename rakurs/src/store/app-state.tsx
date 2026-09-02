import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

/**
 * Preferences that outlive a screen. Only the theme for now: filters and selections
 * belong to the screens that own them, and putting them here is what turned the
 * prototype's state into a junk drawer.
 */

export type Theme = 'light' | 'dark';

const THEME_KEY = 'rakurs-theme';

function readTheme(): Theme {
  // Read synchronously while initialising: setting it in an effect costs an extra
  // render, and in the prototype it looped.
  try {
    return (localStorage.getItem(THEME_KEY) as Theme) || 'light';
  } catch {
    return 'light';
  }
}

interface AppStateContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

const AppStateContext = createContext<AppStateContextValue | null>(null);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readTheme);

  const setTheme = useCallback((next: Theme) => {
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // private mode — the choice simply is not remembered
    }
    setThemeState(next);
  }, []);

  const toggleTheme = useCallback(
    () => setTheme(theme === 'light' ? 'dark' : 'light'),
    [setTheme, theme],
  );

  const value = useMemo(
    () => ({ theme, setTheme, toggleTheme }),
    [theme, setTheme, toggleTheme],
  );

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export function useAppState(): AppStateContextValue {
  const ctx = useContext(AppStateContext);
  if (!ctx) throw new Error('useAppState вызван вне AppStateProvider');
  return ctx;
}
