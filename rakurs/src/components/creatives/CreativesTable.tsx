import { useMemo } from 'react';
import * as api from '@/api';
import { CheckBox, Segmented, Toggle } from '@/components/ui/primitives';
import { RowsSkeleton } from '@/components/ui/states';
import { useToast } from '@/components/ui/Toast';
import { num, plural } from '@/lib/format';
import {
  emptyTotals,
  groupBy,
  groupStatus,
  statusOf,
  totalsOf,
  type AdsMeta,
  type Totals,
} from '@/lib/selectors';
import { deliveryStyle, roasColor } from '@/lib/tone';
import { useAppState } from '@/store/app-state';
import { useData } from '@/store/data';
import type { ColumnSet, Creative, CreativeLevel, DeliveryStatus } from '@/types';

const GRID = '26px 36px minmax(230px,2.1fr) 0.95fr repeat(6,0.86fr)';

interface Cell {
  v: string;
  fg: string;
  weight?: number;
}

/**
 * Шесть числовых колонок под выбранный набор. `one` передаётся, когда строка
 * соответствует ровно одному объявлению: частота и EMQ не суммируются, поэтому
 * для групп из нескольких объявлений там прочерк.
 */
function cellsFor(t: Totals, one: Creative | null, colSet: ColumnSet, adsMeta: AdsMeta): Cell[] {
  const roas = t.spendKzt ? t.revenue / t.spendKzt : 0;
  const cpBuyer = t.purchases ? Math.round(t.spendKzt / t.purchases) : 0;
  const ctr = t.impressions ? (t.clicks / t.impressions) * 100 : 0;
  const cpr = t.metaResults ? Math.round(t.spendKzt / t.metaResults) : 0;
  const diff = t.metaPurch - t.purchases;

  if (colSet === 'meta')
    return [
      { v: `$${num(t.spendUsd)}`, fg: 'var(--text)' },
      { v: num(t.impressions), fg: 'var(--text-4)' },
      { v: `${ctr.toFixed(2).replace('.', ',')}%`, fg: 'var(--text-4)' },
      { v: String(t.metaResults), fg: 'var(--text)', weight: 700 },
      { v: num(cpr), fg: 'var(--text-4)' },
      { v: one ? (adsMeta[one.creative]?.freq ?? '—') : '—', fg: 'var(--text-4)' },
    ];

  if (colSet === 'match')
    return [
      { v: String(t.metaPurch), fg: 'var(--text-4)' },
      { v: String(t.purchases), fg: 'var(--text)', weight: 700 },
      {
        v: `${diff > 0 ? '+' : ''}${diff}`,
        fg: diff > 2 ? 'var(--danger)' : diff === 0 ? 'var(--accent)' : 'var(--warn)',
      },
      {
        v: `${t.sentToMeta} / ${t.purchases}`,
        fg: t.sentToMeta === t.purchases ? 'var(--accent)' : 'var(--warn)',
      },
      { v: one ? (adsMeta[one.creative]?.emq ?? '—') : '—', fg: 'var(--text-4)' },
      { v: roas.toFixed(1), fg: roasColor(roas), weight: 700 },
    ];

  return [
    { v: `$${num(t.spendUsd)}`, fg: 'var(--text)' },
    { v: String(t.dialogs), fg: 'var(--text-4)' },
    { v: String(t.purchases), fg: 'var(--text)', weight: 700 },
    { v: num(t.revenue), fg: 'var(--text)' },
    { v: roas.toFixed(1), fg: roasColor(roas), weight: 700 },
    { v: cpBuyer ? num(cpBuyer) : '—', fg: cpBuyer > 250000 ? 'var(--danger)' : 'var(--text-3)' },
  ];
}

const columnLabels: Record<ColumnSet, { label: string; hl?: boolean }[]> = {
  crm: [
    { label: 'Расход' },
    { label: 'Диалоги' },
    { label: 'Покупки CRM', hl: true },
    { label: 'Выручка CRM', hl: true },
    { label: 'ROAS' },
    { label: 'Цена покупателя' },
  ],
  meta: [
    { label: 'Расход' },
    { label: 'Показы' },
    { label: 'CTR' },
    { label: 'Результаты Meta' },
    { label: 'Цена результата' },
    { label: 'Частота' },
  ],
  match: [
    { label: 'Покупки Meta' },
    { label: 'Покупки CRM', hl: true },
    { label: 'Расхождение', hl: true },
    { label: 'Ушло в Meta' },
    { label: 'EMQ' },
    { label: 'ROAS' },
  ],
};

interface Row {
  key: string;
  /**
   * Объявления, которые покрывает строка. У кампании и группы их несколько:
   * тумблер на такой строке должен выключать все входящие объявления, иначе
   * он щёлкает вхолостую.
   */
  adIds: string[];
  name: string;
  meta: string;
  status: DeliveryStatus;
  drillable: boolean;
  thumb: string | null;
  cells: Cell[];
  onOpen: () => void;
}

export function CreativesTable() {
  const { state, patch, set } = useAppState();
  const { core, visible } = useData();
  const toast = useToast();
  const { level, colSet, dCamp, dSet, picked, off, selCr } = state;

  const adsMeta: AdsMeta = core?.adsMeta ?? {};

  // Проваливание: кампания → её группы → её объявления.
  const pool = useMemo(
    () =>
      visible.filter(
        (a) => (!dCamp || a.name === dCamp) && (!dSet || adsMeta[a.creative]?.adset === dSet)
      ),
    [visible, dCamp, dSet, adsMeta]
  );

  const { rows, totalsLabel, nameColLabel } = useMemo((): {
    rows: Row[];
    totalsLabel: string;
    nameColLabel: string;
  } => {
    if (level === 'campaign') {
      const groups = groupBy(pool, (a) => a.name);
      return {
        nameColLabel: 'Кампания',
        totalsLabel: `Итого · ${groups.length} ${plural(groups.length, 'кампания', 'кампании', 'кампаний')}`,
        rows: groups.map((g) => {
          const m = adsMeta[g.items[0].creative];
          return {
            key: g.key,
            adIds: g.items.map((i) => i.creative),
            name: g.key,
            meta: `${m?.objective ?? ''} · ${g.items.length} ${plural(g.items.length, 'объявление', 'объявления', 'объявлений')} · ${g.items[0].account}`,
            status: groupStatus(g.items, off, adsMeta),
            drillable: true,
            thumb: null,
            cells: cellsFor(
              totalsOf(g.items, adsMeta),
              g.items.length === 1 ? g.items[0] : null,
              colSet,
              adsMeta
            ),
            onOpen: () => patch({ level: 'adset', dCamp: g.key, dSet: null }),
          };
        }),
      };
    }

    if (level === 'adset') {
      const groups = groupBy(pool, (a) => adsMeta[a.creative]?.adset ?? '—');
      return {
        nameColLabel: 'Группа объявлений',
        totalsLabel: `Итого · ${groups.length} ${plural(groups.length, 'группа', 'группы', 'групп')}`,
        rows: groups.map((g) => ({
          key: g.key,
          adIds: g.items.map((i) => i.creative),
          name: g.key,
          meta: `${g.items[0].name} · ${g.items[0].placement}`,
          status: groupStatus(g.items, off, adsMeta),
          drillable: true,
          thumb: null,
          cells: cellsFor(
            totalsOf(g.items, adsMeta),
            g.items.length === 1 ? g.items[0] : null,
            colSet,
            adsMeta
          ),
          onOpen: () => patch({ level: 'ad', dCamp: g.items[0].name, dSet: g.key }),
        })),
      };
    }

    return {
      nameColLabel: 'Объявление · креатив',
      totalsLabel: `Итого · ${pool.length} ${plural(pool.length, 'объявление', 'объявления', 'объявлений')}`,
      rows: pool.map((a) => {
        const m = adsMeta[a.creative];
        return {
          key: a.creative,
          adIds: [a.creative],
          name: a.creative,
          meta: `${m?.adset ?? ''} · ${m?.format ?? ''}`,
          status: statusOf(a, off, adsMeta),
          drillable: false,
          thumb: m?.format.split(' ')[0] ?? null,
          cells: cellsFor(totalsOf([a], adsMeta), a, colSet, adsMeta),
          onOpen: () => set('selCr', a.creative),
        };
      }),
    };
  }, [level, pool, off, colSet, adsMeta, patch, set]);

  const poolTotals = useMemo(() => totalsOf(pool, adsMeta), [pool, adsMeta]);
  const totalCells = cellsFor(
    core ? poolTotals : emptyTotals,
    pool.length === 1 ? pool[0] : null,
    colSet,
    adsMeta
  );

  const levels: { id: CreativeLevel; label: string; count: string }[] = [
    { id: 'campaign', label: 'Кампании', count: String(groupBy(visible, (a) => a.name).length) },
    {
      id: 'adset',
      label: 'Группы объявлений',
      count: String(groupBy(visible, (a) => adsMeta[a.creative]?.adset ?? '—').length),
    },
    { id: 'ad', label: 'Объявления', count: String(visible.length) },
  ];

  const tableNote =
    colSet === 'meta'
      ? 'Показатели из Ads Manager как есть. Meta считает результатом переписку или заявку — не оплату, поэтому по этим колонкам нельзя судить о деньгах.'
      : colSet === 'match'
        ? `Расхождение — сколько покупок Meta приписала себе сверх реально оплаченных в CRM. По видимым аккаунтам Meta завышает на ${poolTotals.metaPurch - poolTotals.purchases}.`
        : 'Выручка — сумма оплаченных сделок из CRM, привязанных к объявлению. Каждая оплата уходит в Meta Conversions API с суммой чека, поэтому алгоритм оптимизируется на покупателей, а не на объём заявок.';

  /** Ключ строки → объявления под ней; нужен массовым действиям над выделением. */
  const adIdsByKey = useMemo(
    () => Object.fromEntries(rows.map((r) => [r.key, r.adIds])),
    [rows]
  );

  /**
   * Тумблер меняет статус объявлений в Meta. Интерфейс переключается сразу, до
   * ответа: ждать секунду на каждый щелчок неприятно. Если запрос не прошёл —
   * возвращаем как было и говорим об этом.
   */
  async function toggleRow(row: Row) {
    const turningOff = row.status !== 'off';
    const before = { ...off };
    const next = { ...off };
    row.adIds.forEach((id) => (next[id] = turningOff));
    patch({ off: next });
    try {
      await Promise.all(row.adIds.map((id) => api.setAdStatus(id, !turningOff)));
    } catch (e) {
      patch({ off: before });
      toast.fail(e, 'Не удалось изменить статус объявления');
    }
  }

  function pickRow(key: string) {
    set('picked', picked.includes(key) ? picked.filter((k) => k !== key) : [...picked, key]);
  }

  async function runBulk(action: 'pause' | 'activate' | 'duplicate', label: string) {
    const keys = [...picked];
    const ids = keys.flatMap((k) => adIdsByKey[k] ?? [k]);
    const before = { ...off };
    if (action !== 'duplicate') {
      const next = { ...off };
      ids.forEach((id) => (next[id] = action === 'pause'));
      patch({ off: next, picked: [] });
    } else {
      set('picked', []);
    }
    try {
      await api.bulkAdAction(ids, action);
      toast.ok(`${label}: ${keys.length} ${plural(keys.length, 'строка', 'строки', 'строк')}`);
    } catch (e) {
      patch({ off: before, picked: keys });
      toast.fail(e, `Не удалось выполнить «${label}»`);
    }
  }

  const bulkActions = [
    { label: 'Выключить', run: () => runBulk('pause', 'Выключено') },
    { label: 'Включить', run: () => runBulk('activate', 'Включено') },
    { label: 'Дублировать', run: () => runBulk('duplicate', 'Продублировано') },
  ];

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <Segmented
          size="lg"
          items={levels}
          value={level}
          onChange={(id) => patch({ level: id, dCamp: null, dSet: null })}
        />

        {(dCamp || dSet) && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 9,
              padding: '7px 11px',
              border: '1px solid var(--line-2)',
              borderRadius: 9,
              background: 'var(--card)',
            }}
          >
            <button
              type="button"
              className="btn-link"
              style={{ fontSize: 12 }}
              onClick={() => patch({ dCamp: null, dSet: null, level: 'campaign' })}
            >
              Все кампании
            </button>
            <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>›</span>
            <span style={{ fontSize: 12, color: 'var(--text)' }}>{dSet ?? dCamp}</span>
            <button
              type="button"
              className="btn-quiet"
              style={{ fontSize: 12 }}
              onClick={() => patch({ dCamp: null, dSet: null, level: 'campaign' })}
            >
              ✕
            </button>
          </div>
        )}

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>Колонки</span>
          <Segmented
            size="sm"
            items={[
              { id: 'crm', label: 'Деньги из CRM' },
              { id: 'meta', label: 'Показатели Meta' },
              { id: 'match', label: 'Сверка Meta ↔ CRM' },
            ]}
            value={colSet}
            onChange={(id) => set('colSet', id)}
          />
        </div>
      </div>

      <div className="card" style={{ overflow: 'hidden' }}>
        {picked.length > 0 && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 14,
              padding: '11px 18px',
              borderBottom: '1px solid var(--line)',
              background: 'rgba(13,150,104,0.07)',
            }}
          >
            <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--accent)' }}>
              Выбрано {picked.length}
            </span>
            <div style={{ display: 'flex', gap: 8 }}>
              {bulkActions.map((b) => (
                <button
                  key={b.label}
                  type="button"
                  className="btn-sm"
                  style={{ fontSize: 11.5 }}
                  onClick={b.run}
                >
                  {b.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="btn-quiet"
              style={{ marginLeft: 'auto' }}
              onClick={() => set('picked', [])}
            >
              Снять выделение
            </button>
          </div>
        )}

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: GRID,
            gap: 10,
            padding: '11px 18px',
            borderBottom: '1px solid var(--line)',
            background: 'var(--sunken)',
            alignItems: 'center',
          }}
        >
          <div />
          <div />
          <div className="col-head">{nameColLabel}</div>
          <div className="col-head">Доставка</div>
          {columnLabels[colSet].map((c) => (
            <div
              key={c.label}
              className="col-head"
              style={{
                color: c.hl ? 'var(--accent)' : 'var(--text-dim)',
                textAlign: 'right',
                lineHeight: 1.3,
              }}
            >
              {c.label}
            </div>
          ))}
        </div>

        {!core ? (
          <RowsSkeleton rows={5} height={54} />
        ) : (
          rows.map((r) => {
            const ds = deliveryStyle(r.status);
            const on = r.status !== 'off';
            const isPicked = picked.includes(r.key);
            return (
              <div
                key={r.key}
                className="row-hover"
                style={{
                  display: 'grid',
                  gridTemplateColumns: GRID,
                  gap: 10,
                  padding: '12px 18px',
                  borderBottom: '1px solid var(--line-soft)',
                  alignItems: 'center',
                  background: isPicked
                    ? 'rgba(13,150,104,0.06)'
                    : level === 'ad' && selCr === r.key
                      ? 'var(--raise)'
                      : 'transparent',
                }}
              >
                <div onClick={() => pickRow(r.key)} style={{ cursor: 'pointer' }}>
                  <CheckBox on={isPicked} />
                </div>
                <div onClick={() => toggleRow(r)} style={{ cursor: 'pointer' }}>
                  <Toggle on={on} />
                </div>
                <div
                  onClick={r.onOpen}
                  style={{
                    minWidth: 0,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    cursor: 'pointer',
                  }}
                >
                  {r.thumb && (
                    <div
                      className="mono"
                      style={{
                        width: 30,
                        height: 30,
                        flex: '0 0 auto',
                        borderRadius: 6,
                        background: 'var(--line-soft)',
                        border: '1px solid var(--line-3)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 8.5,
                        fontWeight: 700,
                        color: 'var(--text-dim)',
                      }}
                    >
                      {r.thumb}
                    </div>
                  )}
                  <div style={{ minWidth: 0 }}>
                    <div
                      className="ellipsis"
                      style={{
                        fontSize: 12.5,
                        fontWeight: 600,
                        color: on ? 'var(--text)' : 'var(--text-muted)',
                      }}
                    >
                      {r.name}
                    </div>
                    <div
                      className="ellipsis"
                      style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 3 }}
                    >
                      {r.meta}
                    </div>
                  </div>
                  {r.drillable && (
                    <span
                      style={{
                        flex: '0 0 auto',
                        marginLeft: 'auto',
                        fontSize: 12,
                        color: 'var(--text-faint)',
                      }}
                    >
                      ›
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      flex: '0 0 auto',
                      borderRadius: '50%',
                      background: ds.dot,
                    }}
                  />
                  <span className="ellipsis" style={{ fontSize: 11.5, color: ds.fg }}>
                    {ds.label}
                  </span>
                </div>
                {r.cells.map((c, i) => (
                  <div
                    key={i}
                    className="mono"
                    style={{
                      textAlign: 'right',
                      fontSize: 12.5,
                      fontWeight: c.weight ?? 400,
                      color: c.fg,
                    }}
                  >
                    {c.v}
                  </div>
                ))}
              </div>
            );
          })
        )}

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: GRID,
            gap: 10,
            padding: '13px 18px',
            background: 'var(--sunken)',
            alignItems: 'center',
          }}
        >
          <div />
          <div />
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-3)' }}>
            {core ? totalsLabel : ''}
          </div>
          <div />
          {totalCells.map((c, i) => (
            <div
              key={i}
              className="mono"
              style={{ textAlign: 'right', fontSize: 12.5, fontWeight: 700, color: c.fg }}
            >
              {core ? c.v : ''}
            </div>
          ))}
        </div>

        <div
          style={{
            padding: '13px 18px',
            borderTop: '1px solid var(--line-soft)',
            fontSize: 11.5,
            lineHeight: 1.5,
            color: 'var(--text-dim)',
          }}
        >
          {tableNote}
        </div>
      </div>
    </>
  );
}
