import { Outlet } from 'react-router-dom';
import { Header } from './Header';
import { Sidebar } from './Sidebar';

/**
 * The shell shrinks with the viewport; individual screens own their content layout.
 */
export function Layout() {
  return (
    <div className="app-layout" style={{ display: 'flex', minHeight: '100vh', background: 'var(--page)' }}>
      <Sidebar />
      <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
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
