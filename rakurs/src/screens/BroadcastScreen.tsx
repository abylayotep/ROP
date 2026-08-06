import { useMemo, useState } from 'react';
import * as api from '@/api';
import { Screen } from '@/components/layout/Layout';
import {
  Badge,
  Card,
  CardHead,
  CheckBox,
  Kpi,
  RadioDot,
  Segmented,
} from '@/components/ui/primitives';
import { Async, EmptyState, KpiSkeleton, RowsSkeleton, Skeleton } from '@/components/ui/states';
import { useToast } from '@/components/ui/Toast';
import { BROADCAST_GUARDS, PACE_OPTIONS, SEND_WINDOWS } from '@/lib/constants';
import { useApi } from '@/hooks/useApi';
import { num } from '@/lib/format';
import { preflight, preflightLabel } from '@/lib/broadcast';
import { useAppState } from '@/store/app-state';
import type { BroadcastConfig } from '@/api';
import type { TemplateCategory } from '@/types';

const HISTORY_GRID = '1.6fr 0.9fr 0.7fr 0.7fr 0.7fr 0.7fr 0.8fr 1fr';

export function BroadcastScreen() {
  const config = useApi((signal) => api.getBroadcastConfig(signal), []);

  return (
    <Screen>
      <Async
        state={config}
        skeleton={
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14 }}>
              {Array.from({ length: 4 }, (_, i) => (
                <KpiSkeleton key={i} />
              ))}
            </div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1.3fr 1fr',
                gap: 16,
                alignItems: 'start',
                marginTop: 16,
              }}
            >
              <Skeleton height={520} radius={14} />
              <Skeleton height={520} radius={14} />
            </div>
            <div className="card" style={{ marginTop: 16, overflow: 'hidden' }}>
              <RowsSkeleton rows={4} />
            </div>
          </>
        }
      >
        {(data) => <BroadcastBody config={data} />}
      </Async>
    </Screen>
  );
}

function BroadcastBody({ config }: { config: BroadcastConfig }) {
  const { state, set, patch } = useAppState();
  const toast = useToast();
  const [sending, setSending] = useState(false);
  const { segments, templates, history, quality } = config;

  const result = useMemo(
    () =>
      preflight({
        segments,
        templates,
        tierLimit: quality.tierLimit,
        sentToday: quality.sentToday,
        blockRate: quality.blockRate,
        selSeg: state.selSeg,
        tplCat: state.tplCat,
        selTpl: state.selTpl,
        pace: state.pace,
        win: state.win,
      }),
    [
      segments,
      templates,
      quality,
      state.selSeg,
      state.tplCat,
      state.selTpl,
      state.pace,
      state.win,
    ]
  );

  const broadcastKpis = [
    {
      label: 'Качество номера',
      value:
        quality.rating === 'green' ? 'Зелёное' : quality.rating === 'yellow' ? 'Жёлтое' : 'Красное',
      sub: `блокировок ${(quality.blockRate * 100).toFixed(1).replace('.', ',')}% · порог снижения лимитов 2%`,
      color:
        quality.rating === 'green'
          ? 'var(--accent)'
          : quality.rating === 'yellow'
            ? 'var(--warn)'
            : 'var(--danger)',
      dot:
        quality.rating === 'green'
          ? 'var(--accent-2)'
          : quality.rating === 'yellow'
            ? 'var(--warn)'
            : 'var(--danger-2)',
    },
    {
      label: 'Лимит на сутки',
      value: num(quality.tierLimit),
      sub: `использовано ${num(quality.sentToday)} · лимит на весь портфель, не на номер`,
      color: 'var(--text)',
    },
    {
      label: 'Открытых окон 24 ч',
      value: String(quality.openWindows),
      sub: 'этим клиентам можно писать свободно, без шаблона',
      color: 'var(--text)',
    },
    {
      label: 'Отписались всего',
      value: String(quality.optedOut),
      sub: 'ответили СТОП · отправка им заблокирована навсегда',
      color: 'var(--text-4)',
    },
  ];

  const visibleTemplates = templates.filter((t) => t.cat === state.tplCat);

  /** Запуск рассылки. Кнопка закрыта, пока предполётная проверка красная. */
  async function startBroadcast() {
    if (result.blocked || sending || state.bcSent) return;
    setSending(true);
    try {
      await api.startBroadcast({
        segmentIds: state.selSeg,
        templateId: state.selTpl,
        pace: state.pace,
        window: state.win,
      });
      set('bcSent', true);
      toast.ok(`Рассылка запущена · ${num(result.willSend)} получателей`);
    } catch (e) {
      toast.fail(e, 'Не удалось запустить рассылку');
    } finally {
      setSending(false);
    }
  }

  const tplCatHint =
    state.tplCat === 'marketing'
      ? 'Marketing: акции и напоминания. Нужна отписка в тексте, действует лимит 2 сообщения в сутки на человека от всех компаний.'
      : 'Utility: только по факту сделки — статус заказа, замер, доставка. Промо в этой категории Meta отклоняет.';

  const winOk = state.win !== '00–24';
  const sendLabel = state.bcSent
    ? 'Рассылка запущена'
    : sending
      ? 'Запускаем…'
      : result.blocked
        ? 'Исправьте отмеченное'
        : `Запустить рассылку · ${num(result.willSend)}`;

  const sendNote = result.blocked
    ? 'Кнопка разблокируется, когда все пункты станут зелёными.'
    : state.pace === 'ramp'
      ? `Сегодня уйдёт около ${num(Math.round(result.willSend * 0.15))} сообщений, остальное — в следующие дни с проверкой качества после каждой партии.`
      : `Отправка равномерно распределится по окну ${state.win}:00.`;

  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14 }}>
        {broadcastKpis.map((k) => (
          <Kpi key={k.label} {...k} size={23} subLineHeight={1.4} />
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr', gap: 16, alignItems: 'start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Шаг 1 — сегменты */}
          <Card>
            <h3 className="card-title" style={{ marginBottom: 4 }}>
              1 · Кому пишем
            </h3>
            <div className="card-hint" style={{ marginBottom: 15 }}>
              сегменты собраны из разбора диалогов — не загруженный список
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
              {segments.map((s) => {
                const on = state.selSeg.includes(s.id);
                const bad = Boolean(s.forbidden);
                return (
                  <div
                    key={s.id}
                    onClick={() =>
                      set(
                        'selSeg',
                        on ? state.selSeg.filter((x) => x !== s.id) : [...state.selSeg, s.id]
                      )
                    }
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 13,
                      padding: '13px 14px',
                      border: `1px solid ${
                        on
                          ? bad
                            ? 'rgba(216,87,76,0.4)'
                            : 'rgba(13,150,104,0.35)'
                          : 'var(--line-2)'
                      }`,
                      borderRadius: 11,
                      background: on
                        ? bad
                          ? 'rgba(216,87,76,0.06)'
                          : 'rgba(13,150,104,0.05)'
                        : 'var(--sunken)',
                      cursor: 'pointer',
                    }}
                  >
                    <CheckBox on={on} size={18} danger={bad} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 600 }}>{s.label}</div>
                      <div
                        style={{
                          fontSize: 11,
                          color: 'var(--text-dim)',
                          marginTop: 3,
                          lineHeight: 1.4,
                        }}
                      >
                        {s.meta}
                      </div>
                    </div>
                    <div style={{ flex: '0 0 auto', textAlign: 'right' }}>
                      <div className="mono" style={{ fontSize: 13, fontWeight: 700 }}>
                        {s.forbidden ? '0' : num(s.optIn)}
                      </div>
                      <div style={{ fontSize: 10.5, color: 'var(--text-dim)', marginTop: 2 }}>
                        с согласием
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>

          {/* Шаг 2 — шаблон */}
          <Card>
            <CardHead
              gap={4}
              align="center"
              title={<h3 className="card-title">2 · Шаблон</h3>}
              right={
                <Segmented
                  size="sm"
                  items={[
                    { id: 'marketing' as TemplateCategory, label: 'Marketing' },
                    { id: 'utility' as TemplateCategory, label: 'Utility' },
                  ]}
                  value={state.tplCat}
                  onChange={(id) =>
                    patch({ tplCat: id, selTpl: id === 'marketing' ? 't1' : 't3' })
                  }
                />
              }
            />
            <div className="card-hint" style={{ marginBottom: 15 }}>
              {tplCatHint}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
              {visibleTemplates.map((t) => {
                const on = state.selTpl === t.id;
                return (
                  <div
                    key={t.id}
                    onClick={() => set('selTpl', t.id)}
                    style={{
                      padding: '14px 15px',
                      border: `1px solid ${on ? 'rgba(13,150,104,0.35)' : 'var(--line-2)'}`,
                      borderRadius: 11,
                      background: on ? 'rgba(13,150,104,0.05)' : 'var(--sunken)',
                      cursor: 'pointer',
                    }}
                  >
                    <div
                      style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}
                    >
                      <RadioDot on={on} />
                      <span style={{ fontSize: 12.5, fontWeight: 600 }}>{t.name}</span>
                      <Badge
                        size="sm"
                        bg={
                          t.cat === 'marketing'
                            ? 'rgba(13,150,104,0.14)'
                            : 'rgba(217,161,60,0.14)'
                        }
                        fg={t.cat === 'marketing' ? 'var(--accent)' : 'var(--warn)'}
                      >
                        {t.cat === 'marketing' ? 'Marketing' : 'Utility'}
                      </Badge>
                      <span
                        className="mono"
                        style={{
                          marginLeft: 'auto',
                          fontSize: 10.5,
                          color: t.ok ? 'var(--accent)' : 'var(--warn)',
                        }}
                      >
                        {t.quality}
                      </span>
                    </div>
                    <div
                      className="pretty"
                      style={{ fontSize: 12.5, lineHeight: 1.55, color: 'var(--text-2)' }}
                    >
                      {t.body}
                    </div>
                    <div
                      style={{
                        fontSize: 11,
                        color: 'var(--text-dim)',
                        marginTop: 9,
                        paddingTop: 9,
                        borderTop: '1px solid var(--line-2)',
                      }}
                    >
                      {t.footer}
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>

          {/* Шаг 3 — темп */}
          <Card>
            <h3 className="card-title" style={{ marginBottom: 4 }}>
              3 · Темп отправки
            </h3>
            <div className="card-hint" style={{ marginBottom: 16 }}>
              резкий скачок объёма — один из главных триггеров блокировки
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {PACE_OPTIONS.map((p) => {
                const on = state.pace === p.id;
                return (
                  <div
                    key={p.id}
                    onClick={() => set('pace', p.id)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 13,
                      padding: '13px 14px',
                      border: `1px solid ${
                        on
                          ? p.ok
                            ? 'rgba(13,150,104,0.35)'
                            : 'rgba(216,87,76,0.4)'
                          : 'var(--line-2)'
                      }`,
                      borderRadius: 11,
                      background: on
                        ? p.ok
                          ? 'rgba(13,150,104,0.05)'
                          : 'rgba(216,87,76,0.06)'
                        : 'var(--sunken)',
                      cursor: 'pointer',
                    }}
                  >
                    <RadioDot on={on} danger={!p.ok} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 600 }}>{p.label}</div>
                      <div
                        style={{
                          fontSize: 11,
                          color: 'var(--text-dim)',
                          marginTop: 3,
                          lineHeight: 1.4,
                        }}
                      >
                        {p.meta}
                      </div>
                    </div>
                    <span
                      className="mono"
                      style={{
                        flex: '0 0 auto',
                        fontSize: 11.5,
                        color: p.ok ? 'var(--accent)' : 'var(--danger)',
                      }}
                    >
                      {p.risk}
                    </span>
                  </div>
                );
              })}
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 14,
                marginTop: 16,
                paddingTop: 15,
                borderTop: '1px solid var(--line-2)',
              }}
            >
              <span style={{ fontSize: 12, color: 'var(--text-3)' }}>Окно отправки</span>
              <Segmented
                size="sm"
                items={SEND_WINDOWS.map((w) => ({
                  id: w,
                  label: w === '00–24' ? 'Круглосуточно' : `${w}:00`,
                }))}
                value={state.win as (typeof SEND_WINDOWS)[number]}
                onChange={(w) => set('win', w)}
              />
              <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-dim)' }}>
                {winOk
                  ? 'Ночные сообщения — первая причина жалоб'
                  : 'Ночью люди жалуются и блокируют чаще всего'}
              </span>
            </div>
          </Card>
        </div>

        {/* Предполётная проверка */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div
            className="card"
            style={{
              overflow: 'hidden',
              borderColor: result.blocked ? 'rgba(216,87,76,0.35)' : 'var(--line)',
            }}
          >
            <div
              style={{
                padding: '17px 19px',
                borderBottom: '1px solid var(--line)',
                background: 'var(--sunken)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <h3 className="card-title">Предполётная проверка</h3>
                <Badge
                  bg={result.blocked ? 'rgba(216,87,76,0.16)' : 'rgba(13,150,104,0.16)'}
                  fg={result.blocked ? 'var(--danger)' : 'var(--accent)'}
                >
                  {preflightLabel(result.failed)}
                </Badge>
              </div>
              <div className="card-hint" style={{ marginTop: 6 }}>
                каждый пункт — правило Meta, за которое блокируют номер
              </div>
            </div>

            {result.checks.map((c) => (
              <div
                key={c.label}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 11,
                  padding: '12px 19px',
                  borderBottom: '1px solid var(--line-soft)',
                }}
              >
                <span
                  style={{
                    flex: '0 0 auto',
                    marginTop: 1,
                    fontSize: 12,
                    fontWeight: 700,
                    color: c.ok ? 'var(--accent)' : 'var(--danger)',
                  }}
                >
                  {c.ok ? '✓' : '✕'}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.4 }}>
                    {c.label}
                  </div>
                  <div
                    className="pretty"
                    style={{
                      fontSize: 11,
                      color: 'var(--text-dim)',
                      marginTop: 3,
                      lineHeight: 1.45,
                    }}
                  >
                    {c.meta}
                  </div>
                </div>
              </div>
            ))}

            <div
              style={{ padding: '17px 19px', display: 'flex', flexDirection: 'column', gap: 12 }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  justifyContent: 'space-between',
                  gap: 12,
                }}
              >
                <span style={{ fontSize: 12.5, color: 'var(--text-3)' }}>Уйдёт сообщений</span>
                <span
                  className="mono"
                  style={{ fontSize: 20, fontWeight: 700, color: 'var(--text)' }}
                >
                  {num(result.willSend)}
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {result.excluded.map((e) => (
                  <div
                    key={e.k}
                    style={{
                      display: 'flex',
                      alignItems: 'baseline',
                      justifyContent: 'space-between',
                      gap: 10,
                    }}
                  >
                    <span style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>{e.k}</span>
                    <span className="mono" style={{ fontSize: 11.5, color: e.fg }}>
                      {e.v}
                    </span>
                  </div>
                ))}
              </div>
              <button
                type="button"
                disabled={result.blocked || sending || state.bcSent}
                onClick={startBroadcast}
                style={{
                  marginTop: 4,
                  border: `1px solid ${result.blocked ? 'var(--line-strong)' : 'rgba(13,150,104,0.45)'}`,
                  background: result.blocked ? 'var(--raise)' : 'rgba(13,150,104,0.14)',
                  color: result.blocked ? 'var(--text-muted)' : 'var(--accent)',
                  fontFamily: 'inherit',
                  fontSize: 13,
                  fontWeight: 700,
                  padding: '11px 15px',
                  borderRadius: 10,
                  cursor: result.blocked || sending || state.bcSent ? 'not-allowed' : 'pointer',
                }}
              >
                {sendLabel}
              </button>
              <div
                className="pretty"
                style={{ fontSize: 11, lineHeight: 1.5, color: 'var(--text-dim)' }}
              >
                {sendNote}
              </div>
            </div>
          </div>

          <Card>
            <h3 className="card-title" style={{ marginBottom: 4 }}>
              Что защищает от бана
            </h3>
            <div className="card-hint" style={{ marginBottom: 15 }}>
              это делается автоматически, отключить нельзя
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {BROADCAST_GUARDS.map((g) => (
                <div key={g.title}>
                  <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 4 }}>{g.title}</div>
                  <div
                    className="pretty"
                    style={{ fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-muted)' }}
                  >
                    {g.text}
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>

      {/* История */}
      <div className="card" style={{ overflow: 'hidden' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            gap: 12,
            padding: '17px 19px 14px',
          }}
        >
          <h3 className="card-title">История рассылок</h3>
          <span className="card-hint">блокировки выше 2% роняют качество номера</span>
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: HISTORY_GRID,
            gap: 10,
            padding: '10px 19px',
            borderTop: '1px solid var(--line)',
            borderBottom: '1px solid var(--line)',
            background: 'var(--sunken)',
          }}
        >
          <div className="col-head">Рассылка</div>
          <div className="col-head">Категория</div>
          <div className="col-head" style={{ textAlign: 'right' }}>
            Ушло
          </div>
          <div className="col-head" style={{ textAlign: 'right' }}>
            Прочли
          </div>
          <div className="col-head" style={{ textAlign: 'right' }}>
            Ответили
          </div>
          <div className="col-head" style={{ textAlign: 'right' }}>
            Блок
          </div>
          <div className="col-head" style={{ textAlign: 'right' }}>
            Продажи
          </div>
          <div className="col-head">Качество после</div>
        </div>
        {history.length === 0 && (
          <EmptyState>Рассылок ещё не было</EmptyState>
        )}
        {history.map((h) => (
          <div
            key={h.name}
            style={{
              display: 'grid',
              gridTemplateColumns: HISTORY_GRID,
              gap: 10,
              padding: '13px 19px',
              borderBottom: '1px solid var(--line-soft)',
              alignItems: 'center',
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div className="ellipsis" style={{ fontSize: 12.5, fontWeight: 600 }}>
                {h.name}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 3 }}>{h.date}</div>
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--text-4)' }}>{h.cat}</div>
            <div className="mono" style={{ textAlign: 'right', fontSize: 12.5 }}>
              {h.sent}
            </div>
            <div
              className="mono"
              style={{ textAlign: 'right', fontSize: 12.5, color: 'var(--text-4)' }}
            >
              {h.read}
            </div>
            <div
              className="mono"
              style={{ textAlign: 'right', fontSize: 12.5, color: 'var(--text-4)' }}
            >
              {h.replied}
            </div>
            <div className="mono" style={{ textAlign: 'right', fontSize: 12.5, color: h.blockFg }}>
              {h.blocked}
            </div>
            <div className="mono" style={{ textAlign: 'right', fontSize: 12.5, fontWeight: 700 }}>
              {h.sales}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <span
                style={{
                  width: 6,
                  height: 6,
                  flex: '0 0 auto',
                  borderRadius: '50%',
                  background: h.qDot,
                }}
              />
              <span style={{ fontSize: 11.5, color: h.qFg }}>{h.quality}</span>
            </div>
          </div>
        ))}
        <div
          style={{ padding: '13px 19px', fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-dim)' }}
        >
          Ракурс считает продажи по этим рассылкам из CRM и отправляет их в Meta как Purchase —
          рассылка тоже попадает в отчёт по деньгам.
        </div>
      </div>
    </>
  );
}
