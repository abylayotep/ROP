import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type {
  ColumnSet,
  CreativeLevel,
  DayKey,
  DialogFilter,
  Period,
  TemplateCategory,
  Theme,
} from '@/types';

const THEME_KEY = 'rakurs-theme';

function readTheme(): Theme {
  // Читаем синхронно при инициализации состояния: setState в эффекте даёт лишний
  // ре-рендер, а в прототипе приводил к зацикливанию.
  try {
    return (localStorage.getItem(THEME_KEY) as Theme) || 'light';
  } catch {
    return 'light';
  }
}

export interface AppState {
  theme: Theme;
  period: Period;

  // Диалоги
  selId: string;
  filter: DialogFilter;
  /** Фильтр по креативу, выставляется при переходе с экрана креативов. */
  creative: string | null;
  panel: 'chat' | 'analysis';

  // Продавцы
  hDay: DayKey;

  // Креативы
  level: CreativeLevel;
  colSet: ColumnSet;
  dCamp: string | null;
  dSet: string | null;
  picked: string[];
  /** Локально выключенные строки: ключ → выключено. В бою — Marketing API. */
  off: Record<string, boolean>;
  selCr: string;

  // Рассылки
  selSeg: string[];
  tplCat: TemplateCategory;
  selTpl: string;
  pace: 'ramp' | 'even' | 'blast';
  win: string;
  bcSent: boolean;

  // AI-агент
  agentTab: 'training' | 'rules' | 'test';
}

const initialState: AppState = {
  theme: readTheme(),
  period: '30д',

  selId: 'd2',
  filter: 'all',
  creative: null,
  panel: 'analysis',

  hDay: 'Пн',

  level: 'campaign',
  colSet: 'crm',
  dCamp: null,
  dSet: null,
  picked: [],
  off: {},
  selCr: 'Видео-креатив 01',

  selSeg: ['s1'],
  tplCat: 'marketing',
  selTpl: 't1',
  pace: 'ramp',
  win: '10–20',
  bcSent: false,

  agentTab: 'training',
};

interface AppStateContextValue {
  state: AppState;
  set: <K extends keyof AppState>(key: K, value: AppState[K]) => void;
  patch: (next: Partial<AppState>) => void;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

const AppStateContext = createContext<AppStateContextValue | null>(null);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState>(initialState);

  const patch = useCallback((next: Partial<AppState>) => {
    setState((prev) => ({ ...prev, ...next }));
  }, []);

  const set = useCallback(
    <K extends keyof AppState>(key: K, value: AppState[K]) => {
      setState((prev) => ({ ...prev, [key]: value }));
    },
    []
  );

  const setTheme = useCallback((theme: Theme) => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // приватный режим — тема просто не запомнится
    }
    setState((prev) => ({ ...prev, theme }));
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme(state.theme === 'light' ? 'dark' : 'light');
  }, [setTheme, state.theme]);

  const value = useMemo(
    () => ({ state, set, patch, setTheme, toggleTheme }),
    [state, set, patch, setTheme, toggleTheme]
  );

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export function useAppState(): AppStateContextValue {
  const ctx = useContext(AppStateContext);
  if (!ctx) throw new Error('useAppState вызван вне AppStateProvider');
  return ctx;
}
