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
