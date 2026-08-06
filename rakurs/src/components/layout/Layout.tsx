import type { ReactNode } from 'react';
import { Header } from './Header';
import { Sidebar } from './Sidebar';

/**
 * Каркас: сайдбар фиксированной ширины и контентная область от 1150px.
 * Прототип рассчитан на десктоп от 1440px, мобильной версии нет — её нужно
 * проектировать отдельно, а не сжимать эти же экраны.
 */
export function Layout({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: 'var(--page)' }}>
      <Sidebar />
      <main style={{ flex: 1, minWidth: 1150, display: 'flex', flexDirection: 'column' }}>
        <Header />
        {children}
      </main>
    </div>
  );
}

/** Отступы секции экрана. */
export function Screen({
  children,
  gap = 16,
  top = 24,
}: {
  children: ReactNode;
  gap?: number;
  top?: number;
}) {
  return (
    <section
      style={{
        padding: `${top}px 26px 40px`,
        display: 'flex',
        flexDirection: 'column',
        gap,
      }}
    >
      {children}
    </section>
  );
}
