import { useState, type CSSProperties } from 'react';
import * as api from '@/api';
import { Bar, Card, CardHead, Dot, Funnel, Segmented } from '@/components/ui/primitives';
import { Async, EmptyState, Skeleton } from '@/components/ui/states';
import { useApi, type ApiState } from '@/hooks/useApi';
import { formatMoney } from '@/lib/money';
import { PERIODS } from '@/lib/periods';
import { useAgent } from '@/store/agent';
import type { Period, StageKind, StatsCurrent, StatsPeriodReport } from '@/types';

/**
 * Где лиды стоят сейчас, куда они двигались и что с этого пришло деньгами.
 *
 * Three cards, and the whole design of the screen is about the fact that they do not cover
 * the same span. «Сейчас в воронке» counts every conversation the cabinet has ever had.
 * «Движение по воронке» knows only what was recorded since `stageHistorySince`, which is
 * the day the migration ran. «Источники и деньги» is honest about the whole history again,
 * because the advertising columns have been filled for every click since the number was
 * connected. An owner reading them side by side will assume one span unless each card says
 * otherwise where he is already looking — so each one carries its own date line, its own
 * controls, and a name that cannot be confused with its neighbour's.
 */

const hint: CSSProperties = {
  fontSize: 11.5,
  color: 'var(--text-dim)',
  marginTop: 8,
  lineHeight: 1.45,
};

const label: CSSProperties = { fontSize: 11.5, color: 'var(--text-dim)', marginBottom: 5 };

/** Подзаголовок под названием карточки: чем эта карточка отличается от соседней. */
const subtitle: CSSProperties = {
  fontSize: 12,
  color: 'var(--text-dim)',
  lineHeight: 1.45,
};

/**
 * Полоса-предупреждение, которую нельзя не заметить.
 *
 * Не подсказка при наведении: это единственная фраза, которая мешает прочитать воронку как
 * утверждение обо всей истории компании, и прятать её под курсор — значит не показывать.
 */
const band: CSSProperties = {
  marginTop: 10,
  padding: '10px 12px',
  borderRadius: 8,
  background: 'var(--warn-a14)',
  border: '1px solid var(--warn-a26)',
  color: 'var(--warn)',
  fontSize: 12,
  lineHeight: 1.45,
};

/** Шапка таблицы источников — та же, что у таблицы моделей в «Расходе». */
const headCell: CSSProperties = { padding: '6px 8px', fontWeight: 500 };

/** Nothing to divide by is not zero per cent, so this is what stands in place of a share. */
const NO_VALUE = '—';

/**
 * Written as an escape rather than the character, for `lib/money.ts`'s reason: a
 * non-breaking space is indistinguishable from an ordinary one in source, and one careless
 * formatter pass turns «12 %» into a line that may break between number and sign.
 */
const NO_BREAK_SPACE = '\u00a0';

const count = (value: number) => value.toLocaleString('ru-RU');

/**
 * Доля предыдущего шага, целыми процентами.
 *
 * Числами, а не строками, и это не оговорка: конверсия — отношение двух счётчиков, а не
 * деньги. Округлять её до целого можно, а сумму — нельзя.
 */
const percent = (share: number) => `${Math.round(share * 100)}${NO_BREAK_SPACE}%`;

/** Начало скользящего окна — всегда в пределах тридцати дней, год не нужен. */
const windowStart = (iso: string) =>
  new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });

/** День, с которого кабинет пишет переходы, — он может быть и в прошлом году. */
const historyStart = (iso: string) =>
  new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });

/** «переход» / «перехода» / «переходов». */
function transitions(value: number): string {
  const hundreds = value % 100;
  const tens = value % 10;
  if (tens === 1 && hundreds !== 11) return 'переход';
  if (tens >= 2 && tens <= 4 && (hundreds < 12 || hundreds > 14)) return 'перехода';
  return 'переходов';
}

/** Цвет полосы по смыслу стадии: продажа зелёная, ожидание оплаты жёлтое, прочее ровное. */
const stepFill = (kind: StageKind) =>
  kind === 'success'
    ? 'var(--accent)'
    : kind === 'awaiting_payment'
      ? 'var(--warn)'
      : 'var(--accent-4)';

export function StatsScreen() {
  const { agent } = useAgent();

  /**
   * Один период на две нижние карточки, и один запрос на обе.
   *
   * Переключатель стоит в «Движении по воронке», а «Источники и деньги» читают то же
   * состояние: два переключателя рядом можно поставить в разные положения, и тогда экран
   * показывал бы две разные недели под одним заголовком.
   */
  const [period, setPeriod] = useState<Period>('week');

  /**
   * Два запроса, а не один. У снимка периода нет вовсе, и перезагружать его при смене
   * периода значило бы намекать, что период у него есть.
   */
  const current = useApi<StatsCurrent>((signal) => api.getStatsCurrent(agent.id, signal), [
    agent.id,
  ]);
  const report = useApi<StatsPeriodReport>(
    (signal) => api.getStatsPeriod(agent.id, period, signal),
    [agent.id, period],
  );

  return (
    <>
      <StandingCard state={current} />
      <MovementCard state={report} period={period} onPeriod={setPeriod} />
      <SourcesCard state={report} period={period} />
    </>
  );
}

// Module scope, not nested inside StatsScreen: a component declared inside another's render
// body gets a new identity every render, so React remounts it — and every card below would
// be torn down and rebuilt each time the period switch is clicked.

/* ── Сейчас в воронке ────────────────────────────────────────────────────── */

/**
 * Сколько лидов стоит на каждой стадии прямо сейчас.
 *
 * Переключателя периода здесь нет, и это не упущение. Карточка считает все диалоги агента,
 * включая заведённые до седьмого этапа, и спросить её про прошлую неделю нельзя: она
 * показывает положение на этот момент, а не то, что происходило в окне. Именно она
 * отвечает на «почему движение пустое, у меня двести лидов».
 */
function StandingCard({ state }: { state: ApiState<StatsCurrent> }) {
  return (
    <Card>
      <CardHead title="Сейчас в воронке" gap={8} />
      <div style={subtitle}>
        Снимок на сейчас. Считаются все диалоги агента, включая заведённые до этапа 7.
      </div>

      <Async state={state} skeleton={<Skeleton height={140} style={{ marginTop: 14 }} />} compactError>
        {(data) => {
          if (data.total === 0) {
            return (
              <EmptyState>
                Диалогов ещё нет. Статистика появится, когда клиент напишет в WhatsApp.
              </EmptyState>
            );
          }

          // «Без стадии» первой строкой и всегда: это не отсутствие данных, а состояние
          // лида, и именно в ней стоят все диалоги нового кабинета.
          const rows = [
            {
              key: 'unsorted',
              name: 'Без стадии',
              color: 'var(--text-faint)',
              leads: data.unsorted,
            },
            ...data.stages.map((stage) => ({
              key: stage.stageId,
              name: stage.name,
              color: stage.color,
              leads: stage.leads,
            })),
          ];
          // Ширина полосы — доля от самой большой корзины, а не от всех лидов: иначе
          // воронка с одной толстой стадией рисует шесть невидимых чёрточек.
          const widest = Math.max(...rows.map((row) => row.leads), 1);
          const untriaged = data.stages.every((stage) => stage.leads === 0);

          return (
            <>
              {/* Строки показываются и в этом случае: нулевая стадия — это факт о
                  кабинете, а не отсутствие ответа, и спрятать «Без стадии» вместе с ними
                  значило бы спрятать число, которое всё объясняет. */}
              {untriaged && (
                <div style={{ ...hint, marginTop: 12, color: 'var(--text-muted)' }}>
                  Ни один диалог ещё не разобран по стадиям — все лиды в «Без стадии».
                </div>
              )}

              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 9,
                  marginTop: 14,
                }}
              >
                {rows.map((row) => (
                  <div key={row.key} style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
                    <Dot size={7} color={row.color} />
                    <div
                      style={{
                        width: 168,
                        flex: '0 0 168px',
                        fontSize: 12.5,
                        color: 'var(--text-3)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {row.name}
                    </div>
                    <Bar width={`${(row.leads / widest) * 100}%`} fill={row.color} height={7} />
                    <div
                      className="mono"
                      style={{
                        width: 72,
                        flex: '0 0 72px',
                        textAlign: 'right',
                        fontSize: 12.5,
                        fontWeight: 700,
                      }}
                    >
                      {count(row.leads)}
                    </div>
                  </div>
                ))}
              </div>

              <div style={hint}>Всего диалогов: {count(data.total)}.</div>
            </>
          );
        }}
      </Async>
    </Card>
  );
}

/* ── Движение по воронке ─────────────────────────────────────────────────── */

/**
 * Что лиды делали за период — единственная карточка экрана, которая знает не всю историю.
 *
 * Дата, с которой кабинет пишет переходы, стоит под заголовком всегда, а не только когда
 * период её задевает: владелец, который увидит здесь меньше, чем в снимке выше, должен
 * прочитать причину там же, где увидел расхождение.
 */
function MovementCard({
  state,
  period,
  onPeriod,
}: {
  state: ApiState<StatsPeriodReport>;
  period: Period;
  onPeriod: (period: Period) => void;
}) {
  // Certain: `period` is one of the three the list is built from.
  const chosen = PERIODS.find((item) => item.id === period)!;

  return (
    <Card>
      <CardHead
        title="Движение по воронке"
        gap={8}
        right={
          <Segmented
            items={PERIODS.map((item) => ({ id: item.id, label: item.label }))}
            value={period}
            onChange={onPeriod}
            size="sm"
          />
        }
      />

      <Async state={state} skeleton={<Skeleton height={180} style={{ marginTop: 14 }} />} compactError>
        {(report) => {
          const since = new Date(report.since);
          const recordedFrom = new Date(report.stageHistorySince);
          const older = since.getTime() < recordedFrom.getTime();
          const nothingMoved = report.funnel.every((step) => step.entered === 0);

          return (
            <>
              <div style={subtitle}>
                Переходы записываются с {historyStart(report.stageHistorySince)}.
              </div>
              <div style={{ ...subtitle, marginTop: 4 }}>
                {chosen.plainly}, с {windowStart(report.since)}.
              </div>

              {older && (
                <div style={band}>
                  Период начинается раньше, чем кабинет начал записывать переходы. Всё, что
                  было до {historyStart(report.stageHistorySince)}, здесь не учтено — сколько
                  лидов где стоит сейчас, показывает карточка выше.
                </div>
              )}

              {nothingMoved ? (
                <EmptyState>
                  За этот период лидов по воронке не двигали. Переходы записываются с{' '}
                  {historyStart(report.stageHistorySince)} — всё, что было раньше, в этой
                  карточке не учтено.
                </EmptyState>
              ) : (
                <div style={{ marginTop: 16 }}>
                  <Funnel steps={funnelBars(report)} />
                </div>
              )}

              {/* Плитки прячутся только тогда, когда цепочки нет и считать в них нечего:
                  два нуля под фразой «лидов не двигали» повторили бы её цифрами, а цифры
                  читаются как факт о работе отдела. Отказы и возвраты, которых цепочка не
                  показывает — переход в удалённую стадию или прямо в «Отказ», — остаются
                  на месте: они произошли. */}
              {(!nothingMoved || report.failureEntries > 0 || report.backwardMoves > 0) && (
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: '16px 28px',
                    marginTop: nothingMoved ? 4 : 18,
                  }}
                >
                  <Stat
                    label="Отказов"
                    value={count(report.failureEntries)}
                    color={report.failureEntries > 0 ? 'var(--danger)' : undefined}
                  />
                  <Stat
                    label="Возвратов назад"
                    value={count(report.backwardMoves)}
                    color={report.backwardMoves > 0 ? 'var(--warn)' : undefined}
                  />
                </div>
              )}

              {report.deletedStageEntries > 0 && (
                <div style={hint}>
                  {count(report.deletedStageEntries)}{' '}
                  {transitions(report.deletedStageEntries)} в стадии, которых больше нет
                  {report.deletedStageNames.length > 0
                    ? `: ${report.deletedStageNames.join(', ')}.`
                    : '.'}
                </div>
              )}

              {/* Объяснение к цепочке, а не к карточке: без цепочки объяснять нечего. */}
              {!nothingMoved && (
                <div style={hint}>
                  Лид считается в стадии один раз, сколько бы раз он в неё ни возвращался, и
                  только если он в неё действительно входил. «Отказ» стоит рядом с цепочкой,
                  а не в ней: отказ — не шаг к продаже.
                </div>
              )}
            </>
          );
        }}
      </Async>
    </Card>
  );
}

/**
 * Шаги цепочки в том виде, в каком их рисует `Funnel`.
 *
 * Вынесено из разметки, потому что здесь решается единственный неочевидный вопрос
 * карточки: конверсия `null` — это «делить было не на что», а не ноль процентов. Ноль
 * обвинил бы оператора в потере лидов, которых не было.
 */
function funnelBars(report: StatsPeriodReport) {
  // Ширина — доля от самого широкого шага, а не от первого: шаг может быть шире
  // предыдущего, если лида перетащили в него мимо середины цепочки.
  const widest = Math.max(...report.funnel.map((step) => step.entered), 1);

  return report.funnel.map((step, index) => ({
    label: step.name,
    value: count(step.entered),
    pct: step.conversion === null ? NO_VALUE : percent(step.conversion),
    pctTitle:
      step.conversion === null
        ? index === 0
          ? 'Первый шаг цепочки: делить не на что'
          : 'В предыдущую стадию за период никто не входил — делить не на что'
        : 'Доля тех, кто дошёл сюда из предыдущей стадии',
    w: `${(step.entered / widest) * 100}%`,
    fill: stepFill(step.kind),
  }));
}

/* ── Источники и деньги ──────────────────────────────────────────────────── */

/**
 * Откуда пришли лиды за период и сколько с них оплачено.
 *
 * Предупреждения «записывается с» здесь нет, и это осознанно: рекламные поля диалога
 * заполняются на каждом переходе с тех пор, как подключили номер, а оплаты лежат в заказах
 * с третьего этапа. Эти цифры честны про всё прошлое, и оговорка про день миграции сделала
 * бы их менее достоверными, чем они есть.
 */
function SourcesCard({ state, period }: { state: ApiState<StatsPeriodReport>; period: Period }) {
  // Certain: `period` is one of the three the list is built from.
  const chosen = PERIODS.find((item) => item.id === period)!;

  return (
    <Card>
      <CardHead title="Источники и деньги" gap={8} />
      <div style={subtitle}>
        Считается по всем диалогам, начавшимся за период. Деньги — по всем их оплатам, даже
        если оплата пришла позже.
      </div>

      <Async state={state} skeleton={<Skeleton height={200} style={{ marginTop: 14 }} />} compactError>
        {(report) => (
          <>
            <div style={{ ...subtitle, marginTop: 4 }}>
              {chosen.plainly}, с {windowStart(report.since)}.
            </div>

            {/* Деньги: `null` — это не строка нулей. За период нет ни одной оплаты, и
                сказать об этом словами честнее, чем напечатать «0 ₸». */}
            {report.money === null ? (
              <EmptyState>
                За период нет оплаченных заказов. Заказ попадает сюда, когда его отмечают
                оплаченным в карточке лида.
              </EmptyState>
            ) : (
              <>
                <div
                  style={{ display: 'flex', flexWrap: 'wrap', gap: '16px 28px', marginTop: 16 }}
                >
                  <Stat
                    label="Оплачено"
                    value={formatMoney(report.money.paidTotal, report.currency)}
                    color="var(--accent-2)"
                  />
                  <Stat label="Заказов" value={count(report.money.paidOrders)} />
                  <Stat
                    label="Средний чек"
                    value={
                      report.money.averageOrder === null
                        ? NO_VALUE
                        : formatMoney(report.money.averageOrder, report.currency)
                    }
                  />
                  <Stat
                    label="На одного лида"
                    value={
                      report.money.revenuePerLead === null
                        ? NO_VALUE
                        : formatMoney(report.money.revenuePerLead, report.currency)
                    }
                  />
                </div>

                {report.money.otherCurrencyOrders > 0 && (
                  <div style={hint}>
                    {count(report.money.otherCurrencyOrders)} оплаченных заказов в другой
                    валюте в эти суммы не входят.
                  </div>
                )}
              </>
            )}

            <div style={{ ...label, marginTop: 20, marginBottom: 8 }}>Реклама</div>
            <div style={{ ...subtitle, marginBottom: 10 }}>
              Из {count(report.newLeads)} новых диалогов {count(report.leadsFromAds)} пришли с
              рекламы.
            </div>

            {report.sources.length === 0 ? (
              <EmptyState>
                Ни один диалог за период не пришёл с рекламы. Сюда попадают только переходы по
                Click-to-WhatsApp.
              </EmptyState>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ color: 'var(--text-dim)', textAlign: 'right' }}>
                      <th style={{ ...headCell, textAlign: 'left' }}>Объявление</th>
                      <th style={headCell}>Лидов</th>
                      <th style={headCell}>С идентификатором клика</th>
                      <th style={headCell}>Продаж</th>
                      <th style={headCell}>Оплачено</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.sources.map((source) => (
                      <tr
                        key={source.sourceId ?? 'no-ad-id'}
                        style={{ borderTop: '1px solid var(--line-soft)', textAlign: 'right' }}
                      >
                        <td style={{ padding: '8px', textAlign: 'left' }}>
                          {/* Объявление без заголовка — это идентификатор, а клик без
                              идентификатора — отдельная строка со своим именем: он
                              состоялся и его стоит считать. */}
                          {source.sourceId === null ? (
                            <span style={{ color: 'var(--text-4)' }}>
                              Реклама без идентификатора объявления
                            </span>
                          ) : (
                            <>
                              <div>{source.headline ?? source.sourceId}</div>
                              {source.headline !== null && (
                                <div
                                  className="mono"
                                  style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}
                                >
                                  {source.sourceId}
                                </div>
                              )}
                            </>
                          )}
                        </td>
                        <td className="mono" style={{ padding: '8px' }}>
                          {count(source.leads)}
                        </td>
                        <td className="mono" style={{ padding: '8px' }}>
                          {count(source.withClickId)}
                        </td>
                        <td className="mono" style={{ padding: '8px' }}>
                          {count(source.won)}
                        </td>
                        <td className="mono" style={{ padding: '8px' }}>
                          {formatMoney(source.paidTotal, report.currency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Объяснение к столбцам таблицы: без таблицы объяснять нечего. */}
            {report.sources.length > 0 && (
              <div style={hint}>
                «Продаж» — сколько этих лидов стоит в стадии продажи прямо сейчас, а не
                сколько их дошло туда за период. «Оплачено» — все оплаты этих диалогов, даже
                те, что пришли после конца периода, поэтому сумма за прошлую неделю может
                вырасти позже.
              </div>
            )}
          </>
        )}
      </Async>
    </Card>
  );
}

/**
 * Одно число с подписью, как в «Расходе» на экране агента.
 *
 * Деньги приходят сюда уже отформатированной строкой: сумма — это символы, и превращать её
 * в число ради выравнивания нельзя.
 */
function Stat({ label: caption, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ minWidth: 96 }}>
      <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>{caption}</div>
      <div
        className="mono"
        style={{ fontSize: 19, fontWeight: 700, letterSpacing: '-0.5px', marginTop: 4, color }}
      >
        {value}
      </div>
    </div>
  );
}
