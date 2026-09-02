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
