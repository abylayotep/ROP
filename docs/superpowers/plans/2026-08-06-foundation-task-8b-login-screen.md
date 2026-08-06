# Task 8b: Login screen and the auth gate

Part of [Foundation Implementation Plan](2026-08-06-foundation.md). Global constraints there apply.
Follows [task 8a](2026-08-06-foundation-task-8a-auth-store.md).

**Every string in this screen is user-facing copy, so it is Russian.**

**Files:**
- Create: `rakurs/src/screens/LoginScreen.tsx`
- Modify: `rakurs/src/App.tsx`

**Interfaces:**
- Consumes: `useAuth`, `AuthProvider` (task 8a); `humanError` from `@/api`.
- Produces: `LoginScreen`; `App` gated on auth state.

- [ ] **Step 1: Add the login screen**

`rakurs/src/screens/LoginScreen.tsx`. Colours come from the tokens in `src/styles/tokens.css`, so
the screen follows the theme like every other one. Flat, no shadows — the house style.

```tsx
import { useState, type CSSProperties, type FormEvent } from 'react';
import { humanError } from '@/api';
import { useAuth } from '@/store/auth';

const field: CSSProperties = {
  width: '100%', padding: '10px 12px', marginTop: 6,
  background: 'var(--sunken)', color: 'var(--text)',
  border: '1px solid var(--line)', borderRadius: 8,
  font: 'inherit', outline: 'none',
};

const label: CSSProperties = { display: 'block', fontSize: 13, color: 'var(--text-3)' };

export function LoginScreen() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email, password);
      // On success this component unmounts — deliberately no setBusy(false).
    } catch (e) {
      setError(humanError(e));
      setBusy(false);
    }
  }

  return (
    <div style={{
      minHeight: '100vh', display: 'grid', placeItems: 'center',
      background: 'var(--page)', color: 'var(--text)',
    }}>
      <form onSubmit={onSubmit} style={{
        width: 340, padding: 28,
        background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 12,
      }}>
        <div style={{ fontSize: 18, fontWeight: 600 }}>Ракурс</div>
        <div style={{ marginTop: 4, marginBottom: 20, color: 'var(--text-muted)', fontSize: 13 }}>
          Войдите, чтобы открыть кабинет
        </div>

        <label style={label}>
          Почта
          <input
            style={field} type="email" value={email} autoComplete="username" required
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>

        <label style={{ ...label, marginTop: 14 }}>
          Пароль
          <input
            style={field} type="password" value={password} autoComplete="current-password" required
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>

        {error && (
          <div role="alert" style={{ marginTop: 14, fontSize: 13, color: 'var(--danger)' }}>
            {error}
          </div>
        )}

        <button type="submit" disabled={busy} style={{
          width: '100%', marginTop: 20, padding: '10px 12px',
          background: 'var(--accent)', color: 'var(--on-accent)',
          border: 'none', borderRadius: 8, font: 'inherit', fontWeight: 600,
          cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1,
        }}>
          {busy ? 'Входим…' : 'Войти'}
        </button>
      </form>
    </div>
  );
}
```

- [ ] **Step 2: Gate the app**

Rewrite `rakurs/src/App.tsx`. The router already wraps `App` in `main.tsx`, so `LoginScreen`
renders inside it with no change there:

```tsx
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

  // Blank rather than a spinner: the session check is one local request, and a
  // spinner that flashes for 40ms reads as a glitch.
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
```

- [ ] **Step 3: Typecheck and build**

```bash
npm --prefix rakurs run typecheck && npm --prefix rakurs run build
```

Expected: both pass.

- [ ] **Step 4: Verify by hand against the real server**

Start the test database and the server:

```bash
docker compose -f deploy/compose.test.yml up -d
DATABASE_URL=postgres://rakurs:rakurs@localhost:55432/rakurs_test \
  SESSION_SECRET=$(head -c 32 /dev/urandom | base64) npm --prefix server run dev
```

Set `VITE_API_PROXY=http://localhost:3000` in `rakurs/.env.local`, run
`npm --prefix rakurs run dev`, and open the app.

Expected: the login screen, not the cabinet. A wrong password shows «Неверная почта или пароль».
No user exists yet — task 9a adds the CLI that creates one, and a successful login is verified
there.

- [ ] **Step 5: Commit**

```bash
git add rakurs/src/screens/LoginScreen.tsx rakurs/src/App.tsx
git commit -m "Add the login screen and gate the cabinet behind it"
```
