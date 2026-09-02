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
