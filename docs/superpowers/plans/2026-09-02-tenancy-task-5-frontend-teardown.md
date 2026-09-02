# Task 5: Frontend teardown

Part of [Tenancy and Shell](2026-09-02-tenancy-and-shell.md).

The seven prototype screens read `DataProvider`, which calls endpoints that no longer exist,
and 330 lines of contract types that describe a different product. They go together, in one
pass, so the tree is never half-migrated. What is left after this task: login, the design
system, and an authenticated placeholder that Tasks 6–8 turn into the cabinet.

Nothing here is deleted "to be restored later". Each stage brings its screen back on real data.

**Files:**
- Delete: `rakurs/mock-server/`, six screens, four component directories, five lib modules,
  `rakurs/src/store/data.tsx`
- Modify: `packages/contract/index.ts`, `rakurs/src/api/index.ts`, `rakurs/src/api/client.ts`,
  `rakurs/src/store/app-state.tsx`, `rakurs/src/store/auth.tsx`, `rakurs/src/App.tsx`,
  `rakurs/src/main.tsx`, `rakurs/package.json`

**Interfaces:**
- Consumes: contract types `Agent`, `Me` from Task 4.
- Produces: `getMe`, `login`, `logout`, `listAgents`, `createAgent`, `getAgent`, `updateAgent`
  from `rakurs/src/api/index.ts`; `useAuth()` whose `state.user` is a `Me`.

---

- [ ] **Step 1: Delete the prototype**

```bash
cd rakurs
rm -rf mock-server \
       src/components/creatives src/components/dialogs \
       src/components/sellers src/components/settings \
       src/screens/AgentScreen.tsx src/screens/BroadcastScreen.tsx \
       src/screens/CreativesScreen.tsx src/screens/DialogsScreen.tsx \
       src/screens/OverviewScreen.tsx src/screens/SellersScreen.tsx \
       src/screens/SettingsScreen.tsx \
       src/store/data.tsx \
       src/lib/selectors.ts src/lib/navigation.ts src/lib/broadcast.ts \
       src/lib/constants.ts src/lib/tone.ts
cd ..
```

Remove the `"mock"` line from `rakurs/package.json` scripts — the server it ran is gone.

- [ ] **Step 2: Prune the contract**

`packages/contract/index.ts` keeps only the tenancy block added in Task 4. Replace the whole
file with:

```ts
/**
 * The shapes the server sends and the cabinet reads. Both sides import this file, so a
 * response cannot drift from what the screen expects without the compiler noticing.
 *
 * Types arrive with the endpoints that emit them: conversations in stage 2, orders in
 * stage 3, and so on. Nothing lives here ahead of a route that returns it.
 */

export type Role = 'owner' | 'member';

/** An account the signed-in person belongs to, with their powers in it. */
export interface Account {
  id: string;
  name: string;
  role: Role;
}

export interface Agent {
  id: string;
  accountId: string;
  name: string;
  description: string;
  timezone: string;
}

/** The signed-in person and where they may go. Returned by login and by /auth/me. */
export interface Me {
  name: string;
  initials: string;
  email: string;
  accounts: Account[];
}
```

- [ ] **Step 3: Rewrite the API module**

Replace `rakurs/src/api/index.ts` with:

```ts
import type { Agent, Me } from '@/types';
import { request } from './client';

export { API_URL, ApiError, humanError, request } from './client';

/**
 * Every call the cabinet makes. Meta and WhatsApp credentials live on the server only:
 * the browser talks to our own /api and never to a vendor directly.
 */

// ── Session ──────────────────────────────────────────────────────────────────

export const getMe = (signal?: AbortSignal) => request<Me>('/auth/me', { signal });

export const login = (email: string, password: string) =>
  request<Me>('/auth/login', { method: 'POST', body: { email, password } });

export const logout = () => request<{ ok: true }>('/auth/logout', { method: 'POST' });

// ── Agents ───────────────────────────────────────────────────────────────────

export const listAgents = (accountId: string, signal?: AbortSignal) =>
  request<Agent[]>(`/accounts/${accountId}/agents`, { signal });

export const createAgent = (
  accountId: string,
  body: { name: string; description: string; timezone: string },
) => request<Agent>(`/accounts/${accountId}/agents`, { method: 'POST', body });

export const getAgent = (agentId: string, signal?: AbortSignal) =>
  request<Agent>(`/agents/${agentId}`, { signal });

export const updateAgent = (
  agentId: string,
  body: { name?: string; description?: string; timezone?: string },
) => request<Agent>(`/agents/${agentId}`, { method: 'PATCH', body });
```

In `rakurs/src/api/client.ts` delete the now-unused `periodDays` export (the last line of
the file) — periods belong to the statistics stage.

- [ ] **Step 4: Trim the app state to the theme**

Replace `rakurs/src/store/app-state.tsx` with:

```tsx
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
```

- [ ] **Step 5: Teach the auth store the new payload**

In `rakurs/src/store/auth.tsx` replace the import
`import { getMe, login as apiLogin, logout as apiLogout, type AuthUser } from '@/api';`
with:

```tsx
import { getMe, login as apiLogin, logout as apiLogout } from '@/api';
import type { Me } from '@/types';
```

and the authenticated variant of `AuthState` with:

```tsx
  | { status: 'authenticated'; user: Me };
```

Nothing else in the file changes: it already stores whatever login returns.

- [ ] **Step 6: Leave one authenticated placeholder**

Replace `rakurs/src/App.tsx` with:

```tsx
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
```

In `rakurs/src/main.tsx` delete the `DataProvider` import and its element, leaving
`AppStateProvider > ToastProvider > App`.

- [ ] **Step 7: Typecheck and build**

```bash
npm --prefix rakurs run typecheck
npm --prefix rakurs run build
```

Expected: PASS. If the compiler names a file still importing a deleted module, that file
belongs to the prototype too — delete it and note it in the commit message.

- [ ] **Step 8: Look at it once**

```bash
npm --prefix server run dev
```

and in a second terminal `npm --prefix rakurs run dev`. Open http://localhost:5173, sign in
with the account from Task 2, and confirm the page says `Вход выполнен: Владелец`.

- [ ] **Step 9: Commit**

```bash
git add -A rakurs packages/contract
git commit -m "Remove the prototype screens and their fixtures"
```
