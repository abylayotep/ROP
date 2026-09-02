# Task 7: The shell — sidebar, header, sections

Part of [Tenancy and Shell](2026-09-02-tenancy-and-shell.md).

The chrome every later stage hangs its screens on: a sidebar with the agent and its seven
sections, a header with the section title and the person, and seven screens that say plainly
which stage will fill them. An honest empty state is the point — a reader must be able to tell
an unfinished section from a broken one.

**Files:**
- Create: `rakurs/src/lib/sections.ts`
- Create: `rakurs/src/screens/SectionScreen.tsx`
- Create: `rakurs/src/components/layout/Sidebar.tsx`, `Header.tsx`, `Layout.tsx` (Task 5
  deleted the prototype versions)
- Modify: `rakurs/src/App.tsx`

**Interfaces:**
- Consumes: `useAgent()` from Task 6, `useAppState()` from Task 5, `useAuth()`.
- Produces: `SECTIONS: SectionDef[]` from `rakurs/src/lib/sections.ts` where
  `SectionDef { path: string; label: string; pending: string }`, and `SectionScreen`.

---

- [ ] **Step 1: Name the sections once**

Create `rakurs/src/lib/sections.ts`:

```ts
/**
 * The cabinet's seven sections, in menu order.
 *
 * One list feeds the routes, the sidebar and the header title, so a section cannot exist
 * in the menu without a route or gain a second name in the header.
 */

export interface SectionDef {
  /** Path segment under /a/:agentId/. */
  path: string;
  label: string;
  /** What is missing and when it arrives. Empty once the section is real. */
  pending: string;
}

export const SECTIONS: SectionDef[] = [
  {
    path: 'orders',
    label: 'Заказы',
    pending: 'Воронка заказов появится на этапе 3 — после того, как заработают диалоги.',
  },
  {
    path: 'dialogs',
    label: 'Диалоги',
    pending: 'Переписка появится на этапе 2, вместе с подключением WhatsApp.',
  },
  {
    path: 'knowledge',
    label: 'База знаний',
    pending: 'Загрузка документов и карточки товаров появятся на этапе 4.',
  },
  {
    path: 'agent',
    label: 'Агент',
    pending: 'Скрипт продаж, выбор модели и правила появятся на этапе 5.',
  },
  {
    path: 'integrations',
    label: 'Интеграции',
    pending: 'WhatsApp появится на этапе 2, Meta Conversions API — на этапе 6.',
  },
  {
    path: 'stats',
    label: 'Статистика',
    pending: 'Воронка, конверсия и источники лидов появятся на этапе 7.',
  },
  { path: 'settings', label: 'Настройки', pending: '' },
];

export const sectionByPath = (path: string): SectionDef | undefined =>
  SECTIONS.find((section) => section.path === path);
```

- [ ] **Step 2: Write the section screen**

Create `rakurs/src/screens/SectionScreen.tsx`:

```tsx
import { Card } from '@/components/ui/primitives';
import { EmptyState } from '@/components/ui/states';
import type { SectionDef } from '@/lib/sections';

/**
 * A section that has no endpoint behind it yet.
 *
 * It says which stage brings it rather than showing an empty table: a table with no rows
 * reads as "no orders", which would be a lie about data that is not connected at all.
 */
export function SectionScreen({ section }: { section: SectionDef }) {
  return (
    <Card>
      <EmptyState>{section.pending}</EmptyState>
    </Card>
  );
}
```

- [ ] **Step 3: Write the sidebar**

Create `rakurs/src/components/layout/Sidebar.tsx`:

```tsx
import { Link, NavLink } from 'react-router-dom';
import { SECTIONS } from '@/lib/sections';
import { useAgent } from '@/store/agent';

export function Sidebar() {
  const { agent } = useAgent();

  return (
    <aside
      style={{
        width: 238,
        flex: '0 0 238px',
        borderRight: '1px solid var(--line)',
        background: 'var(--panel)',
        display: 'flex',
        flexDirection: 'column',
        padding: '22px 0 16px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 20px 18px' }}>
        <div
          style={{
            width: 28,
            height: 28,
            borderRadius: 8,
            background: 'var(--accent-2)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontWeight: 800,
            fontSize: 15,
            color: 'var(--on-accent)',
          }}
        >
          Р
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
          <div className="ellipsis" style={{ fontSize: 15, fontWeight: 700 }}>
            {agent.name}
          </div>
          {/* The switcher is a link home rather than a dropdown: the picker already
              groups agents by account, and duplicating that here would mean two places
              to keep in step. */}
          <Link
            to="/"
            style={{
              fontSize: 10.5,
              color: 'var(--text-dim)',
              letterSpacing: '0.3px',
              textTransform: 'uppercase',
              textDecoration: 'none',
            }}
          >
            Сменить агента
          </Link>
        </div>
      </div>

      <nav style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '0 10px' }}>
        {SECTIONS.map((section) => (
          <NavLink
            key={section.path}
            to={section.path}
            style={({ isActive }) => ({
              display: 'block',
              padding: '9px 11px',
              borderRadius: 9,
              fontSize: 13.5,
              fontWeight: 500,
              textDecoration: 'none',
              background: isActive ? 'rgba(13,150,104,0.14)' : 'transparent',
              color: isActive ? 'var(--accent)' : 'var(--text-4)',
            })}
          >
            {section.label}
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}
```

- [ ] **Step 4: Write the header**

Create `rakurs/src/components/layout/Header.tsx`:

```tsx
import { useLocation } from 'react-router-dom';
import { sectionByPath } from '@/lib/sections';
import { useAppState } from '@/store/app-state';
import { useAuth } from '@/store/auth';

const chip = {
  border: '1px solid var(--line-2)',
  background: 'var(--seg)',
  color: 'var(--text-3)',
  fontFamily: 'inherit',
  fontSize: 11.5,
  fontWeight: 600,
  padding: '6px 11px',
  borderRadius: 9,
  cursor: 'pointer',
} as const;

export function Header() {
  const { theme, toggleTheme } = useAppState();
  const { state, signOut } = useAuth();
  const location = useLocation();

  const path = location.pathname.split('/')[3] ?? '';
  const title = sectionByPath(path)?.label ?? '';
  const initials = state.status === 'authenticated' ? state.user.initials : '';

  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 18,
        padding: '16px 26px',
        borderBottom: '1px solid var(--line)',
        background: 'var(--panel)',
      }}
    >
      <div style={{ fontSize: 14.5, fontWeight: 600 }}>{title}</div>

      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 14 }}>
        <button
          type="button"
          onClick={toggleTheme}
          title="Переключить светлую и тёмную тему"
          style={chip}
        >
          {theme === 'light' ? '☾ Ночь' : '☀ День'}
        </button>
        <div className="avatar" style={{ width: 30, height: 30, fontSize: 11.5 }}>
          {initials}
        </div>
        <button type="button" onClick={() => void signOut()} title="Выйти" style={chip}>
          Выйти
        </button>
      </div>
    </header>
  );
}
```

- [ ] **Step 5: Put the outlet in the layout**

Create `rakurs/src/components/layout/Layout.tsx`:

```tsx
import { Outlet } from 'react-router-dom';
import { Header } from './Header';
import { Sidebar } from './Sidebar';

/**
 * Fixed sidebar and a content area from 1150px. Desktop from 1440px by design: a phone
 * layout has to be drawn on its own, not squeezed out of these screens.
 */
export function Layout() {
  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: 'var(--page)' }}>
      <Sidebar />
      <main style={{ flex: 1, minWidth: 1150, display: 'flex', flexDirection: 'column' }}>
        <Header />
        <section
          style={{
            padding: '24px 26px 40px',
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
          }}
        >
          <Outlet />
        </section>
      </main>
    </div>
  );
}
```

The prototype's exported `Screen` helper does not come back: the layout owns those paddings now.

- [ ] **Step 6: Route through the real shell**

In `rakurs/src/App.tsx` delete the temporary `AgentShell` and `Section` components and the
local `SECTIONS` array, import the shared list and the layout, and use them:

```tsx
import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from '@/components/layout/Layout';
import { SECTIONS } from '@/lib/sections';
import { AgentsScreen } from '@/screens/AgentsScreen';
import { LoginScreen } from '@/screens/LoginScreen';
import { SectionScreen } from '@/screens/SectionScreen';
import { AgentProvider } from '@/store/agent';
import { AuthProvider, useAuth } from '@/store/auth';
```

and inside `AuthGate`:

```tsx
      <Route
        path="/a/:agentId"
        element={
          <AgentProvider>
            <Layout />
          </AgentProvider>
        }
      >
        <Route index element={<Navigate to="orders" replace />} />
        {SECTIONS.map((section) => (
          <Route
            key={section.path}
            path={section.path}
            element={<SectionScreen section={section} />}
          />
        ))}
      </Route>
```

- [ ] **Step 7: Typecheck and build**

```bash
npm --prefix rakurs run typecheck
npm --prefix rakurs run build
```

Expected: PASS.

- [ ] **Step 8: Click through every section**

With both dev servers running, open the agent and check each of the seven links: the sidebar
highlights the active one, the header title matches it, and six of them state which stage
brings them. `Настройки` shows an empty card — Task 8 fills it. Toggle the theme and reload:
the choice survives.

- [ ] **Step 9: Commit**

```bash
git add -A rakurs
git commit -m "Add the cabinet shell and honest section placeholders"
```
