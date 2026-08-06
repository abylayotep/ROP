import { useMemo } from 'react';
import * as api from '@/api';
import { Screen } from '@/components/layout/Layout';
import { Bar, Card, CardHead, Funnel, Kpi, type FunnelStep } from '@/components/ui/primitives';
import { Async, EmptyState, ErrorState, KpiSkeleton, Skeleton } from '@/components/ui/states';
import { features } from '@/config';
import { useApi } from '@/hooks/useApi';
import { comma, mln, mln2, num, plural } from '@/lib/format';
import { useContextNavigation } from '@/lib/navigation';
import { toneColor, verdictTone } from '@/lib/tone';
import { useAppState } from '@/store/app-state';
import { useData } from '@/store/data';

export function OverviewScreen() {
  const { state } = useAppState();
  const { core, visible, totals, currency, error, reload } = useData();
  const { navigate, openInsight, openCreative } = useContextNavigation();

  const overview = useApi((signal) => api.getOverview(state.period, signal), [state.period]);
  const capi = useApi((signal) => api.getCapiReconciliation(state.period, signal), [state.period]);

  const topCreatives = useMemo(
    () =>
      visible
        .slice()
        .sort((a, b) => b.revenue / b.spendKzt - a.revenue / a.spendKzt)
        .slice(0, 3)
        .map((c) => {
          const tone = verdictTone(c.verdict);
          return {
            key: c.creative,
            name: `${c.creative} · ${c.name}`,
            meta: `${c.purchases} ${plural(c.purchases, 'покупка', 'покупки', 'покупок')} · ${mln2(c.revenue)} ${currency}`,
            roas: (c.revenue / c.spendKzt).toFixed(1),
            bg: tone.bg,
            color: tone.fg,
          };
        }),
    [visible, currency]
  );

  if (error && !core) {
    return (
      <Screen gap={18}>
        <ErrorState error={error} onRetry={reload} />
      </Screen>
    );
  }

  const summary = overview.data?.summary;
  const roas = totals && totals.spendKzt ? totals.revenue / totals.spendKzt : 0;

  const kpis =
    core && totals
      ? [
          {
            label: 'Выручка с рекламы',
            value: `${mln(totals.revenue)} ${currency}`,
            sub: summary
              ? `${summary.revenueDeltaPct > 0 ? '+' : ''}${summary.revenueDeltaPct}% к прошлому периоду · по оплатам из CRM`
              : 'по оплатам из CRM',
            color: 'var(--text)',
          },
          {
            label: 'ROAS',
            value: roas.toFixed(1),
            sub: `1 ${currency} рекламы → ${comma(roas.toFixed(1))} ${currency} выручки`,
            color: 'var(--accent)',
          },
          {
            label: 'Покупатели',
            value: String(totals.purchases),
            sub:
              totals.sentToMeta === totals.purchases
                ? 'все переданы в Meta с суммой чека'
                : `${totals.sentToMeta} из ${totals.purchases} переданы в Meta`,
            color: 'var(--text)',
          },
          {
            label: 'Упущено',
            value: String(totals.losses),
            sub: summary
              ? `диалогов · из них ${summary.lostReadyToBuy} были готовы купить`
              : 'диалогов',
            color: 'var(--danger)',
          },
        ]
      : [];

  const funnel: FunnelStep[] =
    totals && totals.dialogs
      ? [
          {
            label: 'Диалоги',
            value: num(totals.dialogs),
            pct: '100%',
            w: '100%',
            fill: 'var(--line-strong)',
          },
          {
            label: 'Квалифицированы',
            value: String(totals.qual),
            pct: `${Math.round((totals.qual / totals.dialogs) * 100)}%`,
            w: `${Math.round((totals.qual / totals.dialogs) * 100)}%`,
            fill: 'var(--line-strong)',
          },
          {
            label: 'Замер / расчёт',
            value: String(totals.measure),
            pct: `${Math.round((totals.measure / totals.dialogs) * 100)}%`,
            w: `${Math.max(3, Math.round((totals.measure / totals.dialogs) * 100))}%`,
            fill: 'var(--accent-4)',
          },
          {
            label: 'Оплатили',
            value: String(totals.purchases),
            pct: `${comma(((totals.purchases / totals.dialogs) * 100).toFixed(1))}%`,
            w: `${Math.max(3, Math.round((totals.purchases / totals.dialogs) * 100))}%`,
            fill: 'var(--accent-2)',
          },
        ]
      : [];

  return (
    <Screen gap={18}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14 }}>
        {kpis.length
          ? kpis.map((k) => <Kpi key={k.label} {...k} variant="overview" />)
          : Array.from({ length: 4 }, (_, i) => <KpiSkeleton key={i} />)}
      </div>

      <div
        style={{ display: 'grid', gridTemplateColumns: '1.55fr 1fr', gap: 16, alignItems: 'start' }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Card>
            <CardHead
              title="Воронка по данным CRM"
              right={
                <span className="card-hint">
                  {summary
                    ? `от заявки до оплаты — ${comma(summary.crmToPaymentDays)} дня`
                    : ''}
                </span>
              }
            />
            {funnel.length ? (
              <Funnel steps={funnel} />
            ) : core ? (
              <EmptyState>За этот период оплат ещё нет</EmptyState>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
                {Array.from({ length: 4 }, (_, i) => (
                  <Skeleton key={i} height={28} radius={7} />
                ))}
              </div>
            )}
          </Card>

          <Card>
            <CardHead
              title="AI-разбор: где теряем деньги"
              gap={14}
              right={
                <span className="card-hint">
                  {totals
                    ? `${num(totals.dialogs)} ${plural(totals.dialogs, 'диалог разобран', 'диалога разобрано', 'диалогов разобрано')} автоматически`
                    : ''}
                </span>
              }
            />
            <Async
              state={overview}
              compactError
              skeleton={
                <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                  {Array.from({ length: 4 }, (_, i) => (
                    <Skeleton key={i} height={68} radius={10} />
                  ))}
                </div>
              }
            >
              {(data) =>
                data.insights.length ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                    {data.insights.map((i) => (
                      <div
                        key={i.title}
                        style={{
                          display: 'flex',
                          gap: 12,
                          padding: '13px 14px',
                          border: '1px solid var(--line-2)',
                          borderLeft: `2px solid ${toneColor(i.tone)}`,
                          borderRadius: 10,
                          background: 'var(--sunken)',
                        }}
                      >
                        <div
                          style={{
                            flex: 1,
                            minWidth: 0,
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 5,
                          }}
                        >
                          <div
                            className="pretty"
                            style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.4 }}
                          >
                            {i.title}
                          </div>
                          <div className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                            {i.meta}
                          </div>
                        </div>
                        <button
                          type="button"
                          className="btn"
                          onClick={() => openInsight(i.target)}
                          style={{ alignSelf: 'center', flex: '0 0 auto' }}
                        >
                          {i.action}
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <EmptyState>За этот период разбор не нашёл потерь</EmptyState>
                )
              }
            </Async>
          </Card>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {features.capiPanel && (
            <Card>
              <h3 className="card-title" style={{ marginBottom: 4 }}>
                CRM → Ракурс → Meta
              </h3>
              <div className="card-hint" style={{ marginBottom: 15 }}>
                сверка событий за период
              </div>
              <Async
                state={capi}
                compactError
                skeleton={
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {Array.from({ length: 5 }, (_, i) => (
                      <Skeleton key={i} height={16} />
                    ))}
                  </div>
                }
              >
                {(r) => (
                  <>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                      {[
                        { label: 'Принято из CRM', value: r.acceptedFromCrm, color: 'var(--text)' },
                        { label: 'Отправлено в Meta', value: r.sentToMeta, color: 'var(--text)' },
                        {
                          label: 'Подтверждено Meta',
                          value: r.confirmedByMeta,
                          color: 'var(--accent)',
                        },
                        { label: 'Ожидает отправки', value: r.pending, color: 'var(--warn)' },
                        { label: 'Требует проверки', value: r.needsReview, color: 'var(--danger)' },
                      ].map((row) => (
                        <div
                          key={row.label}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: 10,
                            padding: '9px 0',
                            borderBottom: '1px solid var(--line-soft)',
                          }}
                        >
                          <span style={{ fontSize: 12.5, color: 'var(--text-3)' }}>{row.label}</span>
                          <span
                            className="mono"
                            style={{ fontSize: 13, fontWeight: 700, color: row.color }}
                          >
                            {num(row.value)}
                          </span>
                        </div>
                      ))}
                    </div>
                    <div className="sunken-box" style={{ marginTop: 15, padding: '13px 14px' }}>
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'baseline',
                          justifyContent: 'space-between',
                          marginBottom: 9,
                        }}
                      >
                        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-3)' }}>
                          Качество совпадений (EMQ)
                        </span>
                        <span
                          className="mono"
                          style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--accent)' }}
                        >
                          {r.emq.toFixed(1)} / 10
                        </span>
                      </div>
                      <Bar width={`${Math.round(r.emq * 10)}%`} fill="var(--accent-2)" height={6} />
                      <div
                        style={{
                          marginTop: 10,
                          fontSize: 11,
                          lineHeight: 1.5,
                          color: 'var(--text-dim)',
                        }}
                      >
                        Покупки уходят в Meta с суммой чека. Телефон и e-mail хэшируются (SHA-256)
                        до отправки.
                      </div>
                    </div>
                  </>
                )}
              </Async>
            </Card>
          )}

          <Card>
            <CardHead
              title="Креативы: деньги, а не клики"
              gap={15}
              right={
                <button type="button" className="btn-link" onClick={() => navigate('/creatives')}>
                  Все →
                </button>
              }
            />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
              {!core ? (
                Array.from({ length: 3 }, (_, i) => <Skeleton key={i} height={32} />)
              ) : topCreatives.length ? (
                topCreatives.map((c) => (
                  <div
                    key={c.key}
                    onClick={() => openCreative(c.key)}
                    style={{ display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer' }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="ellipsis" style={{ fontSize: 12.5, fontWeight: 600 }}>
                        {c.name}
                      </div>
                      <div
                        className="mono"
                        style={{ fontSize: 10.5, color: 'var(--text-dim)', marginTop: 2 }}
                      >
                        {c.meta}
                      </div>
                    </div>
                    <div
                      className="mono"
                      style={{
                        flex: '0 0 auto',
                        fontSize: 13,
                        fontWeight: 700,
                        padding: '4px 9px',
                        borderRadius: 7,
                        background: c.bg,
                        color: c.color,
                      }}
                    >
                      {c.roas}
                    </div>
                  </div>
                ))
              ) : (
                <EmptyState>Нет объявлений в выбранных аккаунтах</EmptyState>
              )}
            </div>
          </Card>
        </div>
      </div>
    </Screen>
  );
}
