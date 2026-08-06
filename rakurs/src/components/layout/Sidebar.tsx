import { NavLink } from 'react-router-dom';
import { LiveDot } from '@/components/ui/primitives';
import { num } from '@/lib/format';
import { useData } from '@/store/data';

interface NavItem {
  to: string;
  label: string;
  count?: string;
  /** Счётчик подсвечивается акцентом — у беты AI-агента. */
  highlight?: boolean;
}

export function Sidebar() {
  const { core, allTotals } = useData();

  // Пока данные не пришли, счётчики пустые: подставлять нули нельзя, их прочитают
  // как «диалогов нет».
  const items: NavItem[] = [
    { to: '/overview', label: 'Обзор' },
    { to: '/dialogs', label: 'Диалоги', count: allTotals ? num(allTotals.dialogs) : '' },
    { to: '/sellers', label: 'Продавцы', count: core ? String(core.sellers.length) : '' },
    { to: '/creatives', label: 'Креативы', count: core ? String(core.creatives.length) : '' },
    { to: '/broadcast', label: 'Рассылки' },
    { to: '/agent', label: 'AI-агент', count: 'β', highlight: true },
    { to: '/settings', label: 'Интеграции' },
  ];

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
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 20px 24px' }}>
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-0.2px' }}>Ракурс</div>
          <div
            style={{
              fontSize: 10.5,
              color: 'var(--text-dim)',
              letterSpacing: '0.3px',
              textTransform: 'uppercase',
            }}
          >
            AI-разбор продаж
          </div>
        </div>
      </div>

      <nav style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '0 10px' }}>
        {items.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            style={({ isActive }) => ({
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
              width: '100%',
              padding: '9px 11px',
              border: 0,
              borderRadius: 9,
              fontFamily: 'inherit',
              fontSize: 13.5,
              fontWeight: 500,
              cursor: 'pointer',
              textAlign: 'left',
              background: isActive ? 'rgba(13,150,104,0.14)' : 'transparent',
              color: isActive ? 'var(--accent)' : 'var(--text-4)',
            })}
          >
            <span>{item.label}</span>
            <span
              className="mono"
              style={{ fontSize: 11, color: item.highlight ? 'var(--accent)' : 'var(--text-faint)' }}
            >
              {item.count ?? ''}
            </span>
          </NavLink>
        ))}
      </nav>

      <div style={{ marginTop: 'auto', padding: '0 14px' }}>
        <div
          style={{
            border: '1px solid var(--line-2)',
            borderRadius: 12,
            padding: 12,
            background: 'var(--sunken)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 7 }}>
            <LiveDot />
            <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-3)' }}>
              Meta CAPI · активно
            </span>
          </div>
          <div style={{ fontSize: 11, lineHeight: 1.45, color: 'var(--text-dim)' }}>
            Последнее событие <span style={{ color: 'var(--text-3)' }}>Purchase</span> ушло 2 минуты
            назад
          </div>
        </div>
      </div>
    </aside>
  );
}
