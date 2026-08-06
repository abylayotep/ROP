import { useMemo, useState } from 'react';
import * as api from '@/api';
import { Screen } from '@/components/layout/Layout';
import { AttachChip, Badge, Bar, Card, Segmented, Toggle } from '@/components/ui/primitives';
import { Async, EmptyState, Skeleton } from '@/components/ui/states';
import { useToast } from '@/components/ui/Toast';
import { useApi } from '@/hooks/useApi';
import { AGENT_PRE_SEND_CHECKS, DAY_KEYS, HOURS } from '@/lib/constants';
import { num, plural } from '@/lib/format';
import { useContextNavigation } from '@/lib/navigation';
import { toneText } from '@/lib/tone';
import { useAppState } from '@/store/app-state';
import { useData } from '@/store/data';
import type { AgentConfig, DayActivity, DayKey, Seller } from '@/types';

export function AgentScreen() {
  const { state, set } = useAppState();
  const agent = useApi((signal) => api.getAgent(signal), []);

  return (
    <Screen>
      <Async
        state={agent}
        skeleton={
          <>
            <Skeleton height={72} radius={14} />
            <Skeleton height={38} width={330} radius={10} style={{ marginTop: 16 }} />
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1.35fr 1fr',
                gap: 16,
                marginTop: 16,
              }}
            >
              <Skeleton height={420} radius={14} />
              <Skeleton height={420} radius={14} />
            </div>
          </>
        }
      >
        {(config) => (
          <AgentBody
            config={config}
            tab={state.agentTab}
            onTab={(id) => set('agentTab', id)}
            onChanged={agent.reload}
          />
        )}
      </Async>
    </Screen>
  );
}

function AgentBody({
  config,
  tab,
  onTab,
  onChanged,
}: {
  config: AgentConfig;
  tab: 'training' | 'rules' | 'test';
  onTab: (id: 'training' | 'rules' | 'test') => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const { openInsight } = useContextNavigation();
  const [enabled, setEnabled] = useState(config.enabled);
  const [rules, setRules] = useState(config.rules);

  /** Режим агента общий для отдела, поэтому сохраняется на сервере. */
  async function toggleAgent() {
    const next = !enabled;
    setEnabled(next);
    try {
      await api.updateAgent({ enabled: next });
      onChanged();
    } catch (e) {
      setEnabled(!next);
      toast.fail(e, 'Не удалось сохранить режим агента');
    }
  }

  async function toggleRule(id: string, next: boolean) {
    const before = rules;
    setRules((prev) => prev.map((r) => (r.id === id ? { ...r, enabled: next } : r)));
    try {
      await api.updateAgent({ rule: { id, enabled: next } });
    } catch (e) {
      setRules(before);
      toast.fail(e, 'Не удалось сохранить правило');
    }
  }

  return (
    <>
      <div
        className="card"
        style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '16px 18px' }}
      >
        <div
          className="mono"
          style={{
            width: 38,
            height: 38,
            flex: '0 0 auto',
            borderRadius: 11,
            background: 'rgba(13,150,104,0.14)',
            border: '1px solid rgba(13,150,104,0.35)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 13,
            fontWeight: 700,
            color: 'var(--accent)',
          }}
        >
          AI
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 14.5, fontWeight: 700 }}>
            {config.name} · {config.tagline}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 3 }}>
            Обучен на {num(config.trainedOnDialogs)}{' '}
            {plural(
              config.trainedOnDialogs,
              'разобранном диалоге',
              'разобранных диалогах',
              'разобранных диалогах'
            )}{' '}
            · последнее дообучение {config.lastTrainedAt}
          </div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
          <Badge
            bg={enabled ? 'rgba(13,150,104,0.16)' : 'rgba(217,161,60,0.14)'}
            fg={enabled ? 'var(--accent)' : 'var(--warn)'}
            size="lg"
          >
            {enabled ? 'Отвечает клиентам' : 'Только черновики'}
          </Badge>
          <button
            type="button"
            onClick={toggleAgent}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 9,
              border: '1px solid var(--line-strong)',
              background: 'var(--raise)',
              padding: '6px 11px 6px 8px',
              borderRadius: 9,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            <Toggle on={enabled} large />
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-3)' }}>
              {enabled ? 'Включён' : 'Выключен'}
            </span>
          </button>
        </div>
      </div>

      <div style={{ alignSelf: 'flex-start' }}>
        <Segmented
          size="lg"
          padding="8px 15px"
          items={[
            { id: 'training' as const, label: 'Обучение' },
            { id: 'rules' as const, label: 'Правила и время' },
            { id: 'test' as const, label: 'Проверка' },
          ]}
          value={tab}
          onChange={onTab}
        />
      </div>

      {tab === 'training' && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1.35fr 1fr',
            gap: 16,
            alignItems: 'start',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
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
                <h3 className="card-title">На чём обучен</h3>
                <span className="card-hint">обновлено {config.trainingUpdatedAt}</span>
              </div>

              {config.trainingSources.length === 0 && (
                <EmptyState>База знаний ещё не заполнена</EmptyState>
              )}

              {config.trainingSources.map((t) => (
                <div
                  key={t.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 14,
                    padding: '13px 19px',
                    borderTop: '1px solid var(--line-soft)',
                  }}
                >
                  <span
                    style={{
                      width: 7,
                      height: 7,
                      flex: '0 0 auto',
                      borderRadius: '50%',
                      background: toneText(t.state),
                    }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600 }}>{t.label}</div>
                    <div
                      style={{
                        fontSize: 11,
                        color: 'var(--text-dim)',
                        marginTop: 3,
                        lineHeight: 1.4,
                      }}
                    >
                      {t.meta}
                    </div>
                  </div>
                  <span
                    className="mono"
                    style={{ flex: '0 0 auto', fontSize: 11.5, color: toneText(t.state) }}
                  >
                    {t.status}
                  </span>
                  <button
                    type="button"
                    className="btn-sm"
                    style={{ flex: '0 0 auto' }}
                    onClick={() => t.target && openInsight(t.target)}
                  >
                    {t.action}
                  </button>
                </div>
              ))}

              <div
                style={{
                  padding: '14px 19px',
                  borderTop: '1px solid var(--line-soft)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                }}
              >
                <button type="button" className="btn-accent">
                  Дообучить на новых диалогах
                </button>
                <span className="card-hint">{config.retrainHint}</span>
              </div>
            </div>

            <Card style={{ padding: '17px 19px' }} pad={false}>
              <h3 className="card-title" style={{ marginBottom: 4 }}>
                Готовые ответы из выигранных диалогов
              </h3>
              <div className="card-hint" style={{ marginBottom: 15 }}>
                агент повторяет формулировки, после которых люди покупали
              </div>
              {config.patterns.length ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
                  {config.patterns.map((p) => (
                    <div
                      key={p.trigger}
                      style={{
                        padding: '13px 14px',
                        border: '1px solid var(--line-2)',
                        borderRadius: 11,
                        background: 'var(--sunken)',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: 12,
                          marginBottom: 7,
                        }}
                      >
                        <span
                          className="mono"
                          style={{
                            fontSize: 10.5,
                            fontWeight: 700,
                            letterSpacing: '0.4px',
                            textTransform: 'uppercase',
                            color: 'var(--accent)',
                          }}
                        >
                          {p.trigger}
                        </span>
                        <span className="mono" style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
                          {p.stat}
                        </span>
                      </div>
                      <div
                        className="pretty"
                        style={{ fontSize: 12.5, lineHeight: 1.55, color: 'var(--text-2)' }}
                      >
                        {p.answer}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyState>Пока нет выигранных диалогов, на которых можно учиться</EmptyState>
              )}
            </Card>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <Card style={{ padding: '17px 19px' }} pad={false}>
              <h3 className="card-title" style={{ marginBottom: 15 }}>
                Что агент уже сделал
              </h3>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                {config.stats.map((a) => (
                  <div key={a.label}>
                    <div className="eyebrow-sm" style={{ letterSpacing: '0.5px', marginBottom: 6 }}>
                      {a.label}
                    </div>
                    <div
                      className="mono"
                      style={{
                        fontSize: 20,
                        fontWeight: 700,
                        whiteSpace: 'nowrap',
                        color: toneText(a.tone),
                      }}
                    >
                      {a.value}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 3 }}>
                      {a.sub}
                    </div>
                  </div>
                ))}
              </div>
            </Card>

            <Card style={{ padding: '17px 19px' }} pad={false}>
              <h3 className="card-title" style={{ marginBottom: 4 }}>
                Чего агент не делает
              </h3>
              <div className="card-hint" style={{ marginBottom: 14 }}>
                жёсткие запреты, их нельзя обойти промптом клиента
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                {config.forbidden.map((f) => (
                  <div key={f} style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                    <span
                      style={{
                        flex: '0 0 auto',
                        marginTop: 1,
                        fontSize: 12,
                        color: 'var(--danger)',
                      }}
                    >
                      ✕
                    </span>
                    <span
                      className="pretty"
                      style={{ fontSize: 12.5, lineHeight: 1.45, color: 'var(--text-2)' }}
                    >
                      {f}
                    </span>
                  </div>
                ))}
              </div>
            </Card>

            <Card style={{ padding: '17px 19px' }} pad={false}>
              <h3 className="card-title" style={{ marginBottom: 14 }}>
                Тон общения
              </h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
                {config.tone.map((t) => (
                  <div key={t.label}>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 12,
                        marginBottom: 6,
                      }}
                    >
                      <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{t.label}</span>
                      <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                        {t.value}
                      </span>
                    </div>
                    <Bar width={t.w} fill="var(--accent-2)" />
                  </div>
                ))}
              </div>
            </Card>
          </div>
        </div>
      )}

      {tab === 'rules' && <RulesTab config={config} rules={rules} onToggleRule={toggleRule} />}

      {tab === 'test' && (
        <div
          style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, alignItems: 'start' }}
        >
          <div className="card" style={{ overflow: 'hidden' }}>
            <div
              style={{
                padding: '16px 18px',
                borderBottom: '1px solid var(--line)',
                background: 'var(--sunken)',
              }}
            >
              <div style={{ fontSize: 13.5, fontWeight: 600 }}>Как агент отвечает сейчас</div>
              <div className="card-hint" style={{ marginTop: 3 }}>
                реальный диалог из переписки
              </div>
            </div>
            {config.testChat.length ? (
              <div
                style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 10 }}
              >
                {config.testChat.map((m, i) => (
                  <div
                    key={i}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 4,
                      alignItems: m.mine ? 'flex-end' : 'flex-start',
                    }}
                  >
                    <div
                      style={{
                        maxWidth: '88%',
                        padding: '10px 12px',
                        borderRadius: 12,
                        background: m.mine ? 'rgba(13,150,104,0.1)' : 'var(--raise)',
                        border: `1px solid ${m.mine ? 'rgba(13,150,104,0.3)' : 'var(--line-3)'}`,
                      }}
                    >
                      <div
                        className="pretty"
                        style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--text)' }}
                      >
                        {m.text}
                      </div>
                      {m.attach && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 8 }}>
                          {m.attach.map((a) => (
                            <AttachChip key={a}>{a}</AttachChip>
                          ))}
                        </div>
                      )}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 3px' }}>
                      <span className="mono" style={{ fontSize: 10, color: 'var(--text-faint)' }}>
                        {m.time}
                      </span>
                      <span
                        style={{
                          fontSize: 10,
                          color: m.mine ? 'var(--accent)' : 'var(--text-faint)',
                        }}
                      >
                        {m.who}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState>Агент ещё не отвечал клиентам</EmptyState>
            )}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <Card style={{ padding: '17px 19px' }} pad={false}>
              <h3 className="card-title" style={{ marginBottom: 14 }}>
                Проверка перед отправкой
              </h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
                {AGENT_PRE_SEND_CHECKS.map((c) => (
                  <div key={c.label} style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
                    <span style={{ flex: '0 0 auto', fontSize: 12, color: c.color }}>{c.icon}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12.5, color: 'var(--text-2)' }}>{c.label}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>
                        {c.meta}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </Card>

            <Card style={{ padding: '17px 19px' }} pad={false}>
              <h3 className="card-title" style={{ marginBottom: 4 }}>
                Отклонённые ответы за неделю
              </h3>
              <div className="card-hint" style={{ marginBottom: 14 }}>
                агент сгенерировал, проверка не пропустила
              </div>
              {config.rejected.length ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {config.rejected.map((r) => (
                    <div
                      key={r.text}
                      style={{
                        padding: '12px 13px',
                        border: '1px solid rgba(216,87,76,0.26)',
                        borderRadius: 10,
                        background: 'rgba(216,87,76,0.06)',
                      }}
                    >
                      <div
                        className="pretty"
                        style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--text-2)' }}
                      >
                        {r.text}
                      </div>
                      <div
                        className="mono"
                        style={{ fontSize: 10.5, color: 'var(--danger)', marginTop: 7 }}
                      >
                        {r.reason}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyState>За неделю проверка ничего не отклонила</EmptyState>
              )}
            </Card>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * Кто отвечает в каждый час: зелёное — на линии продавцы, жёлтое — подхватывает
 * агент, серое — тишина. Порог в четыре обращения отсекает шум: ради одного
 * сообщения в час поднимать агента незачем.
 */
function buildSchedule(activity: Record<DayKey, DayActivity>, sellers: Seller[]) {
  return DAY_KEYS.map((d) => {
    const day = activity[d];
    return {
      day: d,
      cells: HOURS.map((h, i) => {
        const human = sellers.some((s) => (day?.sellers[s.initials] ?? [])[i] > 0);
        const leads = day?.incoming[i] ?? 0;
        if (human)
          return {
            bg: 'var(--accent-2)',
            bd: 'var(--accent-3)',
            title: `${d} ${h}:00 — продавцы на линии`,
          };
        if (leads >= 4)
          return {
            bg: 'rgba(217,161,60,0.55)',
            bd: 'rgba(217,161,60,0.7)',
            title: `${d} ${h}:00 — отвечает агент, ${leads} обращений`,
          };
        return { bg: 'var(--heat0)', bd: 'var(--heat0-bd)', title: `${d} ${h}:00 — тишина` };
      }),
    };
  });
}

function RulesTab({
  config,
  rules,
  onToggleRule,
}: {
  config: AgentConfig;
  rules: AgentConfig['rules'];
  onToggleRule: (id: string, next: boolean) => void;
}) {
  const { state } = useAppState();
  const { core } = useData();
  const activityQuery = useApi((signal) => api.getActivity(state.period, signal), [state.period]);

  const hourLabels = useMemo(
    () =>
      HOURS.map((h) => ({
        label: h % 2 === 0 ? String(h) : '',
        color: h >= 20 ? 'var(--text-4)' : 'var(--text-faint)',
      })),
    []
  );

  return (
    <div
      style={{ display: 'grid', gridTemplateColumns: '1.25fr 1fr', gap: 16, alignItems: 'start' }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <Card style={{ padding: '17px 19px' }} pad={false}>
          <h3 className="card-title" style={{ marginBottom: 4 }}>
            Когда агент вступает в разговор
          </h3>
          <div className="card-hint" style={{ marginBottom: 15 }}>
            правила проверяются сверху вниз, срабатывает первое подходящее
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {rules.map((r, i) => (
              <div
                key={r.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 13,
                  padding: '13px 14px',
                  border: `1px solid ${r.enabled ? 'rgba(13,150,104,0.28)' : 'var(--line-2)'}`,
                  borderRadius: 11,
                  background: 'var(--sunken)',
                }}
              >
                <span
                  className="mono"
                  style={{
                    flex: '0 0 auto',
                    width: 22,
                    height: 22,
                    borderRadius: 6,
                    background: 'var(--raise)',
                    border: '1px solid var(--line-strong)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 11,
                    fontWeight: 700,
                    color: 'var(--text-muted)',
                  }}
                >
                  {i + 1}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600, lineHeight: 1.4 }}>{r.title}</div>
                  <div
                    style={{
                      fontSize: 11.5,
                      color: 'var(--text-muted)',
                      marginTop: 4,
                      lineHeight: 1.45,
                    }}
                  >
                    {r.meta}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onToggleRule(r.id, !r.enabled)}
                  style={{
                    flex: '0 0 auto',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    border: 0,
                    background: 'transparent',
                    cursor: 'pointer',
                    padding: 0,
                    fontFamily: 'inherit',
                  }}
                >
                  <Toggle on={r.enabled} large />
                </button>
              </div>
            ))}
          </div>
        </Card>

        <Card style={{ padding: '17px 19px' }} pad={false}>
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              gap: 12,
              marginBottom: 4,
            }}
          >
            <h3 className="card-title">Расписание: кто отвечает в какой час</h3>
            <span className="card-hint">{config.timezone}</span>
          </div>
          <div className="card-hint" style={{ marginBottom: 16 }}>
            {config.scheduleSummary}
          </div>
          <Async state={activityQuery} compactError skeleton={<Skeleton height={190} radius={10} />}>
            {(data) => (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {buildSchedule(data, core?.sellers ?? []).map((row) => (
                  <div key={row.day} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div
                      style={{
                        width: 34,
                        flex: '0 0 34px',
                        fontSize: 11.5,
                        fontWeight: 600,
                        color: 'var(--text-3)',
                      }}
                    >
                      {row.day}
                    </div>
                    <div style={{ flex: 1, display: 'flex', gap: 3 }}>
                      {row.cells.map((c, i) => (
                        <div
                          key={i}
                          title={c.title}
                          style={{
                            flex: 1,
                            height: 22,
                            borderRadius: 4,
                            background: c.bg,
                            border: `1px solid ${c.bd}`,
                          }}
                        />
                      ))}
                    </div>
                  </div>
                ))}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3 }}>
                  <div style={{ width: 34, flex: '0 0 34px' }} />
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
                </div>
              </div>
            )}
          </Async>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 18,
              marginTop: 15,
              paddingTop: 14,
              borderTop: '1px solid var(--line)',
              flexWrap: 'wrap',
            }}
          >
            {[
              { label: 'Продавцы на линии', bg: 'var(--accent-2)', bd: 'var(--accent-3)' },
              { label: 'Отвечает агент', bg: 'rgba(217,161,60,0.55)', bd: 'rgba(217,161,60,0.7)' },
              { label: 'Тишина', bg: 'var(--heat0)', bd: 'var(--heat0-bd)' },
            ].map((l) => (
              <div key={l.label} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <div
                  style={{
                    width: 16,
                    height: 12,
                    borderRadius: 3,
                    background: l.bg,
                    border: `1px solid ${l.bd}`,
                  }}
                />
                <span style={{ fontSize: 11, color: 'var(--text-4)' }}>{l.label}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <Card style={{ padding: '17px 19px' }} pad={false}>
          <h3 className="card-title" style={{ marginBottom: 15 }}>
            Тайминги
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {config.timings.map((t) => (
              <div key={t.label}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    justifyContent: 'space-between',
                    gap: 12,
                    marginBottom: 5,
                  }}
                >
                  <span style={{ fontSize: 12.5, color: 'var(--text-2)' }}>{t.label}</span>
                  <span
                    className="mono"
                    style={{ fontSize: 13, fontWeight: 700, color: 'var(--accent)' }}
                  >
                    {t.value}
                  </span>
                </div>
                <div style={{ fontSize: 11, lineHeight: 1.45, color: 'var(--text-dim)' }}>
                  {t.hint}
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card style={{ padding: '17px 19px' }} pad={false}>
          <h3 className="card-title" style={{ marginBottom: 4 }}>
            Передача продавцу
          </h3>
          <div className="card-hint" style={{ marginBottom: 14 }}>
            агент останавливается и зовёт человека, когда:
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
            {config.escalations.map((e) => (
              <div key={e} style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                <span style={{ flex: '0 0 auto', marginTop: 1, fontSize: 12, color: 'var(--warn)' }}>
                  →
                </span>
                <span
                  className="pretty"
                  style={{ fontSize: 12.5, lineHeight: 1.45, color: 'var(--text-2)' }}
                >
                  {e}
                </span>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
