import { Screen } from '@/components/layout/Layout';
import { CreativeBreakdown } from '@/components/creatives/CreativeBreakdown';
import { CreativesTable } from '@/components/creatives/CreativesTable';
import { Kpi, LiveDot } from '@/components/ui/primitives';
import { EmptyState, ErrorState, KpiSkeleton, Skeleton } from '@/components/ui/states';
import * as api from '@/api';
import { useApi } from '@/hooks/useApi';
import { comma, freshness, mln, num, plural } from '@/lib/format';
import { useContextNavigation } from '@/lib/navigation';
import { useAppState } from '@/store/app-state';
import { useData } from '@/store/data';

export function CreativesScreen() {
  const { state } = useAppState();
  const { core, visible, totals, currency: cur, error, reload } = useData();
  const { navigate } = useContextNavigation();

  const overview = useApi((signal) => api.getOverview(state.period, signal), [state.period]);
  const benchmarks = useApi((signal) => api.getBenchmarks(state.period, signal), [state.period]);
  const summary = overview.data?.summary;

  if (error && !core) {
    return (
      <Screen>
        <ErrorState error={error} onRetry={reload} />
      </Screen>
    );
  }

  const selectedIds = core?.settings.selectedAccounts ?? [];
  const onCreatives = (core?.accounts ?? [])
    .filter((a) => selectedIds.includes(a.id))
    .reduce((acc, a) => acc + a.creatives, 0);

  const syncMeta = core
    ? `${selectedIds.length} ${plural(selectedIds.length, 'аккаунт', 'аккаунта', 'аккаунтов')} из ${core.accounts.length} · ${onCreatives} ${plural(onCreatives, 'креатив', 'креатива', 'креативов')} · ${freshness(core.profile.updatedMinutesAgo)}`
    : 'загружаем список аккаунтов…';

  const kpis =
    core && totals
      ? [
          {
            label: 'Расход на рекламу',
            value: `$${num(Math.round(totals.spendKzt / (core.profile.usdRate || 1)))}`,
            sub: `${mln(totals.spendKzt)} ${cur} по курсу НБРК`,
            color: 'var(--text)',
          },
          {
            label: 'Выручка из CRM',
            value: `${mln(totals.revenue)} ${cur}`,
            sub: `${totals.purchases} ${plural(totals.purchases, 'оплаченная сделка', 'оплаченные сделки', 'оплаченных сделок')}`,
            color: 'var(--text)',
          },
          {
            label: 'ROAS',
            value: totals.spendKzt ? (totals.revenue / totals.spendKzt).toFixed(1) : '—',
            sub: summary
              ? `${summary.roasDelta > 0 ? '+' : ''}${comma(summary.roasDelta)} к прошлому периоду`
              : '',
            color: 'var(--accent)',
          },
          {
            label: 'Цена покупателя',
            value: totals.purchases
              ? `${num(Math.round(totals.spendKzt / totals.purchases))} ${cur}`
              : '—',
            sub: summary
              ? `${summary.cpaDeltaPct}% с момента подключения CAPI`.replace('-', '−')
              : '',
            color: 'var(--accent)',
          },
        ]
      : [];

  const selected = visible.find((c) => c.creative === state.selCr) ?? visible[0];

  return (
    <Screen>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '12px 16px',
          border: '1px solid var(--line-2)',
          borderRadius: 12,
          background: 'var(--sunken)',
        }}
      >
        <LiveDot />
        <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>
          Креативы подтягиваются из Meta автоматически · {syncMeta}
        </div>
        <button
          type="button"
          className="btn"
          style={{ marginLeft: 'auto' }}
          onClick={() => navigate('/settings')}
        >
          Выбрать рекламные аккаунты
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14 }}>
        {kpis.length
          ? kpis.map((k) => <Kpi key={k.label} {...k} size={25} />)
          : Array.from({ length: 4 }, (_, i) => <KpiSkeleton key={i} />)}
      </div>

      <CreativesTable />

      {selected ? (
        <CreativeBreakdown creative={selected} benchmarks={benchmarks.data} />
      ) : core ? (
        <div className="card">
          <EmptyState>Выберите объявление в таблице, чтобы увидеть разбор</EmptyState>
        </div>
      ) : (
        <div className="card" style={{ padding: '18px 19px' }}>
          <Skeleton height={14} width="20%" />
          <Skeleton height={20} width="35%" style={{ marginTop: 8 }} />
          <Skeleton height={140} style={{ marginTop: 18 }} />
        </div>
      )}
    </Screen>
  );
}
