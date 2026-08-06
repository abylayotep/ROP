import { Badge, CapiLine, Funnel, type FunnelStep } from '@/components/ui/primitives';
import { comma, mln2, num, plural } from '@/lib/format';
import { useContextNavigation } from '@/lib/navigation';
import { verdictTone } from '@/lib/tone';
import { useData } from '@/store/data';
import type { Benchmarks, Creative } from '@/types';

export function CreativeBreakdown({
  creative: c,
  benchmarks,
}: {
  creative: Creative;
  /** Средние по отделу; пока не пришли — подписи со сравнением не показываем. */
  benchmarks?: Benchmarks;
}) {
  const { openDialogs } = useContextNavigation();
  const { currency: cur } = useData();
  const tone = verdictTone(c.verdict);

  const roas = c.revenue / c.spendKzt;
  const cpa = Math.round(c.spendKzt / c.purchases);
  const avgCheck = Math.round(c.revenue / c.purchases);
  const dialogToBuy = (c.purchases / c.dialogs) * 100;

  const metrics = [
    {
      label: 'Расход',
      value: `$${num(c.spendUsd)}`,
      sub: `${num(c.spendKzt)} ${cur}`,
      color: 'var(--text)',
    },
    {
      label: 'Выручка из CRM',
      value: mln2(c.revenue),
      sub: `${c.purchases} ${plural(c.purchases, 'оплаченная сделка', 'оплаченные сделки', 'оплаченных сделок')}`,
      color: 'var(--text)',
    },
    {
      label: 'ROAS',
      value: roas.toFixed(1),
      sub: `1 ${cur} → ${comma(roas.toFixed(1))} ${cur}`,
      color: tone.fg,
    },
    {
      label: 'Цена покупателя',
      value: num(cpa),
      sub: benchmarks ? `по отделу — ${num(benchmarks.cpa)} ${cur}` : '',
      color: benchmarks && cpa > benchmarks.cpa * 1.35 ? 'var(--danger)' : 'var(--accent)',
    },
    {
      label: 'Средний чек',
      value: num(avgCheck),
      sub: benchmarks ? `по отделу — ${num(benchmarks.averageCheck)} ${cur}` : '',
      color: 'var(--text)',
    },
    {
      label: 'Диалог → покупка',
      value: `${comma(dialogToBuy.toFixed(1))}%`,
      sub: benchmarks ? `по отделу — ${comma(benchmarks.dialogToBuyPct)}%` : '',
      color: benchmarks && dialogToBuy < benchmarks.dialogToBuyPct * 0.6 ? 'var(--danger)' : 'var(--text)',
    },
  ];

  const funnel: FunnelStep[] = [
    { label: 'Диалоги', value: String(c.dialogs), pct: '100%', w: '100%', fill: 'var(--line-strong)' },
    {
      label: 'Квалифицированы',
      value: String(c.qual),
      pct: `${Math.round((c.qual / c.dialogs) * 100)}%`,
      w: `${Math.round((c.qual / c.dialogs) * 100)}%`,
      fill: 'var(--line-strong)',
    },
    {
      label: 'Замер / расчёт',
      value: String(c.measure),
      pct: `${Math.round((c.measure / c.dialogs) * 100)}%`,
      w: `${Math.max(2, Math.round((c.measure / c.dialogs) * 100))}%`,
      fill: 'var(--accent-4)',
    },
    {
      label: 'Оплатили',
      value: String(c.purchases),
      pct: `${comma(dialogToBuy.toFixed(1))}%`,
      w: `${Math.max(2, Math.round(dialogToBuy))}%`,
      fill: 'var(--accent-2)',
    },
  ];

  return (
    <div className="card" style={{ overflow: 'hidden' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 16,
          padding: '18px 19px',
          borderBottom: '1px solid var(--line)',
          background: 'var(--sunken)',
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div className="mono" style={{ fontSize: 12, color: 'var(--accent)', marginBottom: 5 }}>
            {c.creative}
          </div>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>{c.name}</h3>
          <div style={{ fontSize: 11.5, color: 'var(--text-dim)', marginTop: 5 }}>
            {c.audience} · {c.placement} · {c.account}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: '0 0 auto' }}>
          <Badge bg={tone.bg} fg={tone.fg} size="lg">
            {c.verdictLabel}
          </Badge>
          <button
            type="button"
            className="btn"
            onClick={() => openDialogs({ creative: c.creative })}
          >
            Диалоги · {c.dialogs}
          </button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.15fr 1fr', gap: 0 }}>
        <div
          style={{
            padding: '18px 19px',
            borderRight: '1px solid var(--line)',
            display: 'flex',
            flexDirection: 'column',
            gap: 18,
          }}
        >
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 14 }}>
            {metrics.map((m) => (
              <div key={m.label}>
                <div className="eyebrow-sm" style={{ letterSpacing: '0.5px', marginBottom: 6 }}>
                  {m.label}
                </div>
                <div
                  className="mono"
                  style={{ fontSize: 16, fontWeight: 700, whiteSpace: 'nowrap', color: m.color }}
                >
                  {m.value}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 3 }}>{m.sub}</div>
              </div>
            ))}
          </div>

          <div>
            <div className="eyebrow-sm" style={{ marginBottom: 11 }}>
              Путь клиентов с этого креатива
            </div>
            <Funnel steps={funnel} compact />
          </div>
        </div>

        <div
          style={{ padding: '18px 19px', display: 'flex', flexDirection: 'column', gap: 18 }}
        >
          <div>
            <div className="eyebrow-sm" style={{ marginBottom: 10 }}>
              О чём пишут пришедшие с креатива
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {c.asks.map((a) => (
                <div key={a.label} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: 'var(--text-2)' }}>
                    {a.label}
                  </span>
                  <span className="mono" style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                    {a.count}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div>
            <div className="eyebrow-sm" style={{ marginBottom: 10 }}>
              Почему теряем этих клиентов
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {c.losses.map((l) => (
                <div key={l.label} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: 'var(--text-2)' }}>
                    {l.label}
                  </span>
                  <span className="mono" style={{ fontSize: 11.5, color: l.color }}>
                    {l.count}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div
            style={{
              padding: '13px 14px',
              borderRadius: 11,
              background: tone.soft,
              border: `1px solid ${tone.bd}`,
            }}
          >
            <div className="eyebrow-sm" style={{ color: tone.fg, marginBottom: 7 }}>
              Что делать в Ads Manager
            </div>
            <div
              className="pretty"
              style={{ fontSize: 12.5, lineHeight: 1.55, color: 'var(--text-2)' }}
            >
              {c.verdictText}
            </div>
          </div>

          <CapiLine
            color={c.sentToMeta === c.purchases ? 'var(--accent-2)' : 'var(--warn)'}
            title={c.capiTitle}
            meta={c.capiMeta}
          />
        </div>
      </div>
    </div>
  );
}
