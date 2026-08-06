import { Segmented } from '@/components/ui/primitives';
import { Skeleton } from '@/components/ui/states';
import { plural } from '@/lib/format';
import { useAppState } from '@/store/app-state';
import { useData } from '@/store/data';
import type { Period } from '@/types';

const periods: { id: Period; label: string }[] = [
  { id: '7д', label: '7д' },
  { id: '30д', label: '30д' },
  { id: '90д', label: '90д' },
];

export function Header() {
  const { state, set, toggleTheme } = useAppState();
  const { core } = useData();
  const light = state.theme === 'light';
  const profile = core?.profile;

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
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        {profile ? (
          <>
            <div className="ellipsis" style={{ fontSize: 14.5, fontWeight: 600 }}>
              {profile.projectName}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>{profile.planLine}</div>
          </>
        ) : (
          <>
            <Skeleton height={14} width={180} />
            <Skeleton height={10} width={230} style={{ marginTop: 5 }} />
          </>
        )}
      </div>

      <div style={{ marginLeft: 14 }}>
        <Segmented items={periods} value={state.period} onChange={(p) => set('period', p)} />
      </div>

      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 14 }}>
        <span style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>
          {profile
            ? `Обновлено ${profile.updatedMinutesAgo} ${plural(profile.updatedMinutesAgo, 'минуту', 'минуты', 'минут')} назад`
            : ''}
        </span>
        <button
          type="button"
          onClick={toggleTheme}
          title="Переключить светлую и тёмную тему"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            border: '1px solid var(--line-2)',
            background: 'var(--seg)',
            color: 'var(--text-3)',
            fontFamily: 'inherit',
            fontSize: 11.5,
            fontWeight: 600,
            padding: '6px 11px',
            borderRadius: 9,
            cursor: 'pointer',
          }}
        >
          <span style={{ fontSize: 12 }}>{light ? '☾' : '☀'}</span>
          <span>{light ? 'Ночь' : 'День'}</span>
        </button>
        <div className="avatar" style={{ width: 30, height: 30, fontSize: 11.5 }}>
          {profile?.user.initials ?? ''}
        </div>
      </div>
    </header>
  );
}
