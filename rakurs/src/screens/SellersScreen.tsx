import * as api from '@/api';
import { Screen } from '@/components/layout/Layout';
import { Heatmap } from '@/components/sellers/Heatmap';
import { Avatar, Bar, Kpi } from '@/components/ui/primitives';
import { Async, EmptyState, ErrorState, KpiSkeleton, RowsSkeleton, Skeleton } from '@/components/ui/states';
import { useApi } from '@/hooks/useApi';
import { comma, num, plural } from '@/lib/format';
import { replyColor, scoreColor, sellerConvColor } from '@/lib/tone';
import { useAppState } from '@/store/app-state';
import { useData } from '@/store/data';

const GRID = '1.3fr 0.7fr 0.7fr 0.8fr 0.8fr 0.9fr 1.7fr';

export function SellersScreen() {
  const { state } = useAppState();
  const { core, allTotals, error, reload } = useData();

  const activity = useApi((signal) => api.getActivity(state.period, signal), [state.period]);

  // Средняя конверсия по отделу: с ней сравнивается каждый продавец.
  const avgConv = core?.sellers.length
    ? core.sellers.reduce((a, s) => a + s.convValue, 0) / core.sellers.length
    : 0;

  if (error && !core) {
    return (
      <Screen>
        <ErrorState error={error} onRetry={reload} />
      </Screen>
    );
  }

  const summary = core?.sellersSummary;

  const kpis =
    core && allTotals && summary
      ? [
          {
            label: 'Средний ответ по отделу',
            value: `${summary.avgReplyMinutes} мин`,
            sub: `у лучшего продавца — ${summary.bestReplyMinutes} ${plural(summary.bestReplyMinutes, 'минута', 'минуты', 'минут')}`,
            color: replyColor(summary.avgReplyMinutes),
          },
          {
            label: 'Замер предложен',
            value: allTotals.dialogs
              ? `${Math.round((allTotals.qual / allTotals.dialogs) * 100)}%`
              : '—',
            sub: `в ${allTotals.qual} диалогах из ${num(allTotals.dialogs)} · проведён ${allTotals.measure} раз`,
            color: 'var(--text)',
          },
          {
            label: 'Разрыв конверсии',
            value: `×${comma(summary.conversionGap)}`,
            sub: 'между первым и последним продавцом',
            color: summary.conversionGap >= 1.5 ? 'var(--danger)' : 'var(--text)',
          },
        ]
      : [];

  return (
    <Screen>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 14 }}>
        {kpis.length
          ? kpis.map((k) => <Kpi key={k.label} {...k} size={25} />)
          : Array.from({ length: 3 }, (_, i) => <KpiSkeleton key={i} />)}
      </div>

      <Async
        state={activity}
        skeleton={
          <div className="card card-pad">
            <Skeleton height={16} width="30%" />
            <Skeleton height={56} style={{ marginTop: 22 }} />
            <Skeleton height={120} style={{ marginTop: 12 }} />
          </div>
        }
      >
        {(data) => <Heatmap activity={data} sellers={core?.sellers ?? []} />}
      </Async>

      <div className="card" style={{ overflow: 'hidden' }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: GRID,
            gap: 12,
            padding: '11px 18px',
            borderBottom: '1px solid var(--line)',
            background: 'var(--sunken)',
          }}
        >
          <div className="col-head">Продавец</div>
          <div className="col-head" style={{ textAlign: 'right' }}>
            Диалогов
          </div>
          <div className="col-head" style={{ textAlign: 'right' }}>
            Продаж
          </div>
          <div className="col-head" style={{ textAlign: 'right' }}>
            Конверсия
          </div>
          <div className="col-head" style={{ textAlign: 'right' }}>
            Ср. ответ
          </div>
          <div className="col-head">Оценка AI</div>
          <div className="col-head">Что чинить</div>
        </div>

        {!core ? (
          <RowsSkeleton rows={4} height={56} />
        ) : core.sellers.length === 0 ? (
          <EmptyState>За этот период данных по продавцам нет</EmptyState>
        ) : (
          core.sellers.map((s) => {
            const score = scoreColor(s.score);
            return (
              <div
                key={s.initials}
                style={{
                  display: 'grid',
                  gridTemplateColumns: GRID,
                  gap: 12,
                  padding: '14px 18px',
                  borderBottom: '1px solid var(--line-soft)',
                  alignItems: 'center',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                  <Avatar initials={s.initials} />
                  <span className="ellipsis" style={{ fontSize: 12.5, fontWeight: 600 }}>
                    {s.name}
                  </span>
                </div>
                <div className="mono" style={{ textAlign: 'right', fontSize: 12.5 }}>
                  {s.dialogs}
                </div>
                <div
                  className="mono"
                  style={{ textAlign: 'right', fontSize: 12.5, fontWeight: 700 }}
                >
                  {s.sales}
                </div>
                <div
                  className="mono"
                  style={{
                    textAlign: 'right',
                    fontSize: 12.5,
                    color: sellerConvColor(s.convValue, avgConv),
                  }}
                >
                  {s.conv}
                </div>
                <div
                  className="mono"
                  style={{
                    textAlign: 'right',
                    fontSize: 12.5,
                    color: replyColor(s.replyMinutes),
                  }}
                >
                  {s.reply}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Bar width={`${s.score}%`} fill={score} />
                  <span className="mono" style={{ fontSize: 12, fontWeight: 700, color: score }}>
                    {s.score}
                  </span>
                </div>
                <div
                  className="pretty"
                  style={{ fontSize: 11.5, lineHeight: 1.45, color: 'var(--text-4)' }}
                >
                  {s.fix}
                </div>
              </div>
            );
          })
        )}
      </div>
    </Screen>
  );
}
