import { useMemo } from 'react';
import { Avatar, Segmented } from '@/components/ui/primitives';
import { EmptyState } from '@/components/ui/states';
import { DAY_KEYS, HOURS } from '@/lib/constants';
import { plural } from '@/lib/format';
import { heatColor } from '@/lib/tone';
import { useAppState } from '@/store/app-state';
import type { DayActivity, DayKey, Seller } from '@/types';

/**
 * «Кто и когда на линии». Сверху — обращения клиентов по часам, ниже — сообщения
 * каждого продавца. Красные столбики означают часы, когда клиенты пишут, а на
 * линии никого нет: именно оттуда берутся упущенные диалоги.
 */
export function Heatmap({
  activity,
  sellers,
}: {
  activity: Record<DayKey, DayActivity>;
  sellers: Seller[];
}) {
  const { state, set } = useAppState();
  const day = activity?.[state.hDay] ?? activity?.['Пн'];

  const model = useMemo(() => {
    if (!day?.incoming?.length) return null;
    let heatMax = 1;
    let dayTotal = 0;
    sellers.forEach((s) => {
      (day.sellers[s.initials] ?? []).forEach((v) => {
        if (v > heatMax) heatMax = v;
        dayTotal += v;
      });
    });

    const rows = sellers.map((s) => {
      const arr = day.sellers[s.initials] ?? [];
      const sum = arr.reduce((a, b) => a + b, 0);
      return {
        initials: s.initials,
        name: s.name,
        total: sum ? `${sum} сообщ.` : 'не работал',
        cells: HOURS.map((h, i) => {
          const v = arr[i] ?? 0;
          const c = heatColor(v, heatMax);
          return { ...c, title: `${s.name} · ${h}:00 — ${v} сообщений` };
        }),
      };
    });

    const incMax = Math.max(...day.incoming);
    const covered = HOURS.map((_, i) =>
      sellers.some((s) => (day.sellers[s.initials] ?? [])[i] > 0)
    );
    const incoming = day.incoming.map((v, i) => ({
      h: `${Math.max(4, Math.round((v / incMax) * 56))}px`,
      fill: covered[i] ? 'rgba(13,150,104,0.55)' : 'rgba(216,87,76,0.5)',
    }));

    const incomingSum = day.incoming.reduce((a, b) => a + b, 0);
    // Часы без ответа считаем только там, где обращений реально много:
    // одиночное сообщение в 23:00 — не дыра в расписании.
    const uncoveredIdx = HOURS.map((_, i) => i).filter((i) => !covered[i] && day.incoming[i] >= 8);
    const uncovered = uncoveredIdx.map((i) => `${HOURS[i]}:00`);
    const uncoveredLeads = uncoveredIdx.reduce((a, i) => a + day.incoming[i], 0);

    let lastIncomingHour: number = HOURS[0];
    day.incoming.forEach((v, i) => {
      if (v >= 5) lastIncomingHour = HOURS[i];
    });

    return {
      rows,
      incoming,
      incomingSum,
      dayTotal,
      heatMax,
      lastIncomingHour,
      warning: uncovered.length
        ? `Без ответа: ${uncovered.join(', ')} — ${uncoveredLeads} ${plural(uncoveredLeads, 'обращение', 'обращения', 'обращений')}`
        : 'Все часы с обращениями закрыты',
    };
  }, [day, sellers]);


  const hourLabels = HOURS.map((h) => ({
    label: h % 2 === 0 ? String(h) : '',
    color: h >= 20 ? 'var(--text-4)' : 'var(--text-faint)',
  }));

  const legend = [0, 0.2, 0.45, 0.65, 0.9].map((r) =>
    heatColor(r * (model?.heatMax ?? 1), model?.heatMax ?? 1)
  );

  if (!model) {
    return (
      <div className="card card-pad">
        <h3 className="card-title">Кто и когда на линии</h3>
        <EmptyState>За этот период сообщений не было</EmptyState>
      </div>
    );
  }

  return (
    <div className="card card-pad">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 14,
          marginBottom: 4,
        }}
      >
        <h3 className="card-title">Кто и когда на линии</h3>
        <Segmented
          padding="5px 11px"
          items={DAY_KEYS.map((d) => ({ id: d, label: d }))}
          value={state.hDay}
          onChange={(d) => set('hDay', d)}
        />
      </div>
      <div className="card-hint" style={{ marginBottom: 16 }}>
        Сообщения продавцов по часам · {state.hDay}, {model.dayTotal}{' '}
        {plural(model.dayTotal, 'сообщение', 'сообщения', 'сообщений')} · клиенты пишут до{' '}
        {model.lastIncomingHour}:00
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
          <div className="col-head" style={{ width: 150, flex: '0 0 150px' }}>
            Обращения клиентов
          </div>
          <div style={{ flex: 1, display: 'flex', alignItems: 'flex-end', gap: 3, height: 56 }}>
            {model.incoming.map((h, i) => (
              <div
                key={i}
                style={{
                  flex: 1,
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'flex-end',
                  height: '100%',
                  gap: 2,
                }}
              >
                <div style={{ borderRadius: '3px 3px 0 0', background: h.fill, height: h.h }} />
              </div>
            ))}
          </div>
          <div
            className="mono"
            style={{
              width: 78,
              flex: '0 0 78px',
              textAlign: 'right',
              fontSize: 11,
              color: 'var(--text-dim)',
            }}
          >
            {model.incomingSum}{' '}
            {plural(model.incomingSum, 'обращение', 'обращения', 'обращений')}
          </div>
        </div>

        <div style={{ height: 1, background: 'var(--line)', margin: '9px 0' }} />

        {model.rows.map((r) => (
          <div key={r.initials} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div
              style={{
                width: 150,
                flex: '0 0 150px',
                display: 'flex',
                alignItems: 'center',
                gap: 9,
                minWidth: 0,
              }}
            >
              <Avatar initials={r.initials} size={24} />
              <span className="ellipsis" style={{ fontSize: 12, fontWeight: 500 }}>
                {r.name}
              </span>
            </div>
            <div style={{ flex: 1, display: 'flex', gap: 3 }}>
              {r.cells.map((c, i) => (
                <div
                  key={i}
                  title={c.title}
                  style={{
                    flex: 1,
                    height: 26,
                    borderRadius: 4,
                    background: c.bg,
                    border: `1px solid ${c.bd}`,
                  }}
                />
              ))}
            </div>
            <div
              className="mono"
              style={{
                width: 78,
                flex: '0 0 78px',
                textAlign: 'right',
                fontSize: 11.5,
                color: 'var(--text-3)',
              }}
            >
              {r.total}
            </div>
          </div>
        ))}

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3 }}>
          <div style={{ width: 150, flex: '0 0 150px' }} />
          <div style={{ flex: 1, display: 'flex', gap: 3 }}>
            {hourLabels.map((h, i) => (
              <div
                key={i}
                className="mono"
                style={{ flex: 1, textAlign: 'center', fontSize: 9.5, color: h.color }}
              >
                {h.label}
              </div>
            ))}
          </div>
          <div style={{ width: 78, flex: '0 0 78px' }} />
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 18,
          marginTop: 16,
          paddingTop: 14,
          borderTop: '1px solid var(--line)',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span style={{ fontSize: 10.5, color: 'var(--text-dim)' }}>Меньше</span>
          <div style={{ display: 'flex', gap: 2 }}>
            {legend.map((l, i) => (
              <div
                key={i}
                style={{
                  width: 16,
                  height: 12,
                  borderRadius: 3,
                  background: l.bg,
                  border: `1px solid ${l.bd}`,
                }}
              />
            ))}
          </div>
          <span style={{ fontSize: 10.5, color: 'var(--text-dim)' }}>Больше сообщений</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <div
            style={{
              width: 16,
              height: 12,
              borderRadius: 3,
              background: 'rgba(216,87,76,0.5)',
              border: '1px solid rgba(216,87,76,0.7)',
            }}
          />
          <span style={{ fontSize: 10.5, color: 'var(--text-4)' }}>
            Клиенты пишут, никого нет на линии
          </span>
        </div>
        <div style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--danger)' }}>
          {model.warning}
        </div>
      </div>
    </div>
  );
}
