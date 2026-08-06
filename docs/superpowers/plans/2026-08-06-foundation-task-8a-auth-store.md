# Task 8a: Auth calls and the frontend auth store

Part of [Foundation Implementation Plan](2026-08-06-foundation.md). Global constraints there apply.
The screen itself is [task 8b](2026-08-06-foundation-task-8b-login-screen.md).

**Files:**
- Create: `rakurs/src/store/auth.tsx`
- Modify: `rakurs/src/api/index.ts`, `rakurs/src/api/client.ts:82`

**Interfaces:**
- Consumes: `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me` (task 6b).
- Produces: `AuthUser`, `getMe`, `login`, `logout` in `@/api`; `AuthProvider` and
  `useAuth(): { state, signIn, signOut }` in `@/store/auth`; a `rakurs:unauthorized` window
  event fired by the transport on any 401.

- [ ] **Step 1: Add the auth calls**

Append to `rakurs/src/api/index.ts`:

```ts
// ── Авторизация ──────────────────────────────────────────────────────────────

export interface AuthUser {
  name: string;
  initials: string;
  email: string;
}

/** GET /api/auth/me — кто вошёл. 401, если сессии нет. */
export const getMe = (signal?: AbortSignal) => request<AuthUser>('/auth/me', { signal });

export const login = (email: string, password: string) =>
  request<AuthUser>('/auth/login', { method: 'POST', body: { email, password } });

export const logout = () => request<{ ok: true }>('/auth/logout', { method: 'POST' });
```

- [ ] **Step 2: Announce 401 from the transport**

In `rakurs/src/api/client.ts`, as the first line inside `if (!res.ok) {`:

```ts
    // Просроченная сессия: пусть приложение покажет вход, а не каждая панель
    // по отдельности — «нет доступа».
    if (res.status === 401) window.dispatchEvent(new Event('rakurs:unauthorized'));
```

An event rather than a callback threaded through every caller: the transport stays a pure
function of its arguments, and nothing else in `api/` needs to know that sessions exist.

- [ ] **Step 3: Add the auth store**

`rakurs/src/store/auth.tsx`:

```tsx
import {
  createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode,
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
      .then((user) => { if (alive) setState({ status: 'authenticated', user }); })
      .catch(() => { if (alive) setState({ status: 'anonymous' }); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const onUnauthorized = () => setState({ status: 'anonymous' });
    window.addEventListener('rakurs:unauthorized', onUnauthorized);
    return () => window.removeEventListener('rakurs:unauthorized', onUnauthorized);
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    setState({ status: 'authenticated', user: await apiLogin(email, password) });
  }, []);

  const signOut = useCallback(async () => {
    // Logging out locally must not depend on the request succeeding.
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
```

- [ ] **Step 4: Typecheck**

Run: `npm --prefix rakurs run typecheck`
Expected: pass. Nothing renders the provider yet — that is task 8b.

- [ ] **Step 5: Commit**

```bash
git add rakurs/src/store/auth.tsx rakurs/src/api/index.ts rakurs/src/api/client.ts
git commit -m "Add frontend auth store and 401 signalling

The transport fires a window event on any 401 so an expired session can
show the login screen instead of an error inside every panel."
```
