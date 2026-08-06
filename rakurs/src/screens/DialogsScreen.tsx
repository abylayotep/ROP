import { useEffect, useState } from 'react';
import * as api from '@/api';
import { DialogPanel } from '@/components/dialogs/DialogPanel';
import { Screen } from '@/components/layout/Layout';
import { Badge } from '@/components/ui/primitives';
import { EmptyState, ErrorState, RowsSkeleton, Skeleton } from '@/components/ui/states';
import { useApi, useDebounced } from '@/hooks/useApi';
import { money, num } from '@/lib/format';
import { statusStyle } from '@/lib/tone';
import { useAppState } from '@/store/app-state';
import { useData } from '@/store/data';
import type { DialogFilter } from '@/types';

const GRID = '1.15fr 1.15fr 1.5fr 0.75fr 0.9fr';

const filters: { id: DialogFilter; label: string }[] = [
  { id: 'all', label: 'Все' },
  { id: 'buy', label: 'Купили' },
  { id: 'lost', label: 'Упустили' },
  { id: 'work', label: 'В работе' },
];

export function DialogsScreen() {
  const { state, patch, set } = useAppState();
  const { allTotals, currency } = useData();
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search);

  const query = useApi(
    (signal) =>
      api.listDialogs(
        {
          period: state.period,
          filter: state.filter,
          creative: state.creative,
          search: debouncedSearch,
        },
        signal
      ),
    [state.period, state.filter, state.creative, debouncedSearch]
  );

  const shown = query.data ?? [];

  // Если выбранный диалог не проходит фильтр, показываем первый из видимых —
  // иначе панель справа осталась бы от прошлого фильтра.
  const selected = shown.find((d) => d.id === state.selId) ?? shown[0];

  useEffect(() => {
    if (selected && selected.id !== state.selId) set('selId', selected.id);
  }, [selected, state.selId, set]);

  return (
    <Screen gap={14} top={20}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 12px',
            border: '1px solid var(--line-2)',
            borderRadius: 9,
            background: 'var(--card)',
            width: 250,
          }}
        >
          <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>⌕</span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Поиск по клиенту, городу, запросу"
            style={{
              flex: 1,
              minWidth: 0,
              border: 0,
              outline: 'none',
              background: 'transparent',
              fontFamily: 'inherit',
              fontSize: 12.5,
              color: 'var(--text)',
            }}
          />
        </div>

        <div style={{ display: 'flex', gap: 6 }}>
          {filters.map((f) => {
            const on = state.filter === f.id;
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => set('filter', f.id)}
                style={{
                  border: `1px solid ${on ? 'rgba(13,150,104,0.45)' : 'var(--line-2)'}`,
                  padding: '7px 13px',
                  borderRadius: 9,
                  fontFamily: 'inherit',
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: 'pointer',
                  background: on ? 'rgba(13,150,104,0.14)' : 'var(--card)',
                  color: on ? 'var(--accent)' : 'var(--text-4)',
                }}
              >
                {f.label}
              </button>
            );
          })}
        </div>

        {state.creative && (
          <button
            type="button"
            onClick={() => set('creative', null)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              border: '1px solid rgba(13,150,104,0.45)',
              background: 'rgba(13,150,104,0.14)',
              color: 'var(--accent)',
              fontFamily: 'inherit',
              fontSize: 12,
              fontWeight: 600,
              padding: '7px 11px',
              borderRadius: 9,
              cursor: 'pointer',
            }}
          >
            <span>Креатив: {state.creative}</span>
            <span style={{ color: 'var(--text-muted)' }}>✕</span>
          </button>
        )}

        <div style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--text-dim)' }}>
          {state.creative
            ? `Диалоги с креатива «${state.creative}»`
            : allTotals
              ? `Разбор AI обновляется каждые 10 минут · ${num(allTotals.dialogs)} диалогов за период`
              : ''}
        </div>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(520px,1fr) 452px',
          gap: 16,
          alignItems: 'start',
        }}
      >
        <div className="card" style={{ overflow: 'hidden' }}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: GRID,
              gap: 12,
              padding: '11px 16px',
              borderBottom: '1px solid var(--line)',
              background: 'var(--sunken)',
            }}
          >
            <div className="col-head">Клиент</div>
            <div className="col-head">Креатив · кампания</div>
            <div className="col-head">Что спрашивал</div>
            <div className="col-head">Продавец</div>
            <div className="col-head" style={{ textAlign: 'right' }}>
              Итог
            </div>
          </div>

          {query.error && !query.data ? (
            <ErrorState error={query.error} onRetry={query.reload} compact />
          ) : !query.data ? (
            <RowsSkeleton rows={6} height={62} />
          ) : shown.length === 0 ? (
            <EmptyState>По этому фильтру диалогов нет</EmptyState>
          ) : (
            shown.map((d) => {
              const status = statusStyle(d.status);
              return (
                <div
                  key={d.id}
                  className="row-hover"
                  onClick={() => patch({ selId: d.id })}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: GRID,
                    gap: 12,
                    padding: '13px 16px',
                    borderBottom: '1px solid var(--line-soft)',
                    cursor: 'pointer',
                    alignItems: 'start',
                    background: state.selId === d.id ? 'var(--raise)' : 'transparent',
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div className="ellipsis" style={{ fontSize: 12.5, fontWeight: 600 }}>
                      {d.client}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>
                      {d.city} · {d.channel}
                    </div>
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div className="mono ellipsis" style={{ fontSize: 11, color: 'var(--accent)' }}>
                      {d.creative}
                    </div>
                    <div
                      className="ellipsis"
                      style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}
                    >
                      {d.campaign}
                    </div>
                  </div>
                  {/* Обрезка ровно в две строки: 12px × 1.4 = 16.8px на строку. */}
                  <div
                    style={{
                      minWidth: 0,
                      fontSize: 12,
                      lineHeight: '16.8px',
                      maxHeight: '33.6px',
                      color: 'var(--text-3)',
                      overflow: 'hidden',
                    }}
                  >
                    {d.ask}
                  </div>
                  <div
                    className="ellipsis"
                    style={{ minWidth: 0, fontSize: 12, color: 'var(--text-3)' }}
                  >
                    {d.seller}
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'flex-end',
                      gap: 3,
                    }}
                  >
                    <Badge bg={status.bg} fg={status.fg} size="row">
                      {d.status}
                    </Badge>
                    <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      {d.amount ? money(d.amount, currency) : '—'}
                    </span>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {selected ? (
          <DialogPanel dialog={selected} />
        ) : query.data ? (
          <div className="card" style={{ position: 'sticky', top: 20 }}>
            <EmptyState>Выберите диалог слева, чтобы увидеть переписку и разбор</EmptyState>
          </div>
        ) : (
          <div className="card" style={{ padding: '17px 18px' }}>
            <Skeleton height={18} width="45%" />
            <Skeleton height={12} width="70%" style={{ marginTop: 8 }} />
            <Skeleton height={38} style={{ marginTop: 14 }} radius={9} />
            <Skeleton height={34} style={{ marginTop: 12 }} radius={9} />
          </div>
        )}
      </div>
    </Screen>
  );
}
