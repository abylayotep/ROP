import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '@/api';
import type { QrSession } from '@/api';
import { QrCode } from '@/components/settings/QrCode';
import { Screen } from '@/components/layout/Layout';
import { Badge, Card, CheckBox, LiveDot, Segmented } from '@/components/ui/primitives';
import { Async, EmptyState, ErrorState, RowsSkeleton } from '@/components/ui/states';
import { useToast } from '@/components/ui/Toast';
import { useApi } from '@/hooks/useApi';
import { SYNC_MODES, WHATSAPP_STEPS } from '@/lib/constants';
import { mln, plural } from '@/lib/format';
import { spendByAccount } from '@/lib/selectors';
import { toneColor } from '@/lib/tone';
import { useData } from '@/store/data';

/** Как часто спрашиваем, отсканировал ли продавец код. */
const QR_POLL_MS = 2000;

/** Число из строки: узор кода должен меняться вместе с сессией. */
function seedOf(payload: string): number {
  let h = 0;
  for (let i = 0; i < payload.length; i++) h = (h * 31 + payload.charCodeAt(i)) | 0;
  return Math.abs(h) || 1;
}

export function SettingsScreen() {
  const { core, saveSettings, error, reload } = useData();
  const toast = useToast();

  const numbers = useApi((signal) => api.listNumbers(signal), []);
  const integrations = useApi((signal) => api.listIntegrations(signal), []);

  const [session, setSession] = useState<QrSession | null>(null);
  const [linked, setLinked] = useState<string[]>([]);
  const startedAt = useRef(0);

  /** Открыть панель привязки: запрашиваем новую сессию у бэкенда. */
  const startQr = useCallback(async () => {
    try {
      const s = await api.createQrSession();
      startedAt.current = Date.now();
      setSession(s);
    } catch (e) {
      toast.fail(e, 'Не удалось получить QR-код');
    }
  }, [toast]);

  const closeQr = useCallback(
    (notifyServer = true) => {
      setSession((prev) => {
        if (prev && notifyServer) void api.cancelQrSession(prev.sessionId).catch(() => {});
        return null;
      });
    },
    []
  );

  // Пока панель открыта, спрашиваем статус привязки. В бою это можно заменить
  // на WebSocket — экран не изменится, поменяется только источник события.
  useEffect(() => {
    if (!session) return;
    let alive = true;
    const timer = setInterval(async () => {
      try {
        const status = await api.getQrStatus(session.sessionId);
        if (!alive) return;
        if (status.state === 'linked') {
          setLinked((prev) =>
            prev.includes(status.number.phone) ? prev : [...prev, status.number.phone]
          );
          setSession(null);
          numbers.reload();
          toast.ok(`Номер ${status.number.phone} подключён`);
        } else if (status.state === 'expired') {
          setSession(null);
          toast.fail(null, 'Код истёк — запросите новый');
        }
      } catch {
        // Разовая сетевая ошибка при опросе не повод закрывать панель.
      }
    }, QR_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [session, numbers, toast]);

  if (error && !core) {
    return (
      <Screen>
        <ErrorState error={error} onRetry={reload} />
      </Screen>
    );
  }

  const accounts = core?.accounts ?? [];
  const selected = core?.settings.selectedAccounts ?? [];
  const spend = core ? spendByAccount(core.creatives) : {};

  const onCreatives = accounts
    .filter((a) => selected.includes(a.id))
    .reduce((acc, a) => acc + a.creatives, 0);

  const syncMeta = core
    ? `${selected.length} ${plural(selected.length, 'аккаунт', 'аккаунта', 'аккаунтов')} из ${accounts.length} · ${onCreatives} ${plural(onCreatives, 'креатив', 'креатива', 'креативов')} · обновлено 12 минут назад`
    : '';

  async function toggleAccount(id: string) {
    const next = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
    try {
      await saveSettings({ selectedAccounts: next });
    } catch (e) {
      toast.fail(e, 'Не удалось сохранить выбор аккаунтов');
    }
  }

  async function changeSyncMode(mode: string) {
    try {
      await saveSettings({ syncMode: mode });
    } catch (e) {
      toast.fail(e, 'Не удалось сохранить режим синхронизации');
    }
  }

  const allNumbers = numbers.data ?? [];
  const live = allNumbers.filter((n) => n.status === 'Читается').length + linked.length;

  return (
    <Screen>
      {/* Рекламные аккаунты Meta */}
      <div className="card" style={{ overflow: 'hidden' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 16,
            padding: '18px 19px',
            borderBottom: '1px solid var(--line)',
            background: 'var(--sunken)',
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>
                Meta Business · рекламные аккаунты
              </h3>
              <Badge bg="rgba(13,150,104,0.16)" fg="var(--accent)">
                Подключено
              </Badge>
            </div>
            <div
              style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.45 }}
            >
              Отметьте аккаунты, из которых брать кампании и креативы. Остальные Ракурс не читает.
            </div>
          </div>
          <div style={{ marginLeft: 'auto', flex: '0 0 auto', textAlign: 'right' }}>
            <div className="mono" style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
              {core ? `${selected.length} из ${accounts.length} аккаунтов` : ''}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>{syncMeta}</div>
          </div>
        </div>

        {!core ? (
          <RowsSkeleton rows={4} height={52} />
        ) : (
          accounts.map((a) => {
            const on = selected.includes(a.id);
            return (
              <div
                key={a.id}
                className="row-hover"
                onClick={() => toggleAccount(a.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 14,
                  padding: '14px 19px',
                  borderBottom: '1px solid var(--line-soft)',
                  cursor: 'pointer',
                  background: on ? 'rgba(13,150,104,0.05)' : 'transparent',
                }}
              >
                <CheckBox on={on} size={18} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{a.name}</div>
                  <div
                    className="mono"
                    style={{ fontSize: 10.5, color: 'var(--text-dim)', marginTop: 3 }}
                  >
                    {a.num} · {a.currency}
                  </div>
                </div>
                <div style={{ flex: '0 0 130px', textAlign: 'right' }}>
                  <div className="mono" style={{ fontSize: 12, color: 'var(--text-3)' }}>
                    {a.creatives}
                  </div>
                  <div style={{ fontSize: 10.5, color: 'var(--text-dim)', marginTop: 3 }}>
                    активных креативов
                  </div>
                </div>
                <div style={{ flex: '0 0 130px', textAlign: 'right' }}>
                  <div className="mono" style={{ fontSize: 12, color: 'var(--text-3)' }}>
                    {a.spendOverride ?? (spend[a.name] ? `${mln(spend[a.name])} ₸` : '—')}
                  </div>
                  <div style={{ fontSize: 10.5, color: 'var(--text-dim)', marginTop: 3 }}>
                    расход за 30 дней
                  </div>
                </div>
                <div
                  style={{
                    flex: '0 0 150px',
                    textAlign: 'right',
                    fontSize: 11.5,
                    color: on ? a.statusFg : 'var(--text-dim)',
                  }}
                >
                  {on ? a.status : 'Выключен'}
                </div>
              </div>
            );
          })
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '15px 19px' }}>
          <span style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>
            Синхронизация креативов и расходов
          </span>
          <Segmented
            size="sm"
            items={SYNC_MODES.map((m) => ({ id: m, label: m }))}
            value={(core?.settings.syncMode ?? SYNC_MODES[0]) as (typeof SYNC_MODES)[number]}
            onChange={changeSyncMode}
          />
          <span style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--text-dim)' }}>
            Новые креативы появляются в отчёте сами, размечать UTM вручную не нужно
          </span>
        </div>
      </div>

      {/* WhatsApp */}
      <div className="card" style={{ overflow: 'hidden' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 16,
            padding: '18px 19px',
            borderBottom: '1px solid var(--line)',
            background: 'var(--sunken)',
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>
                WhatsApp · номера продавцов
              </h3>
              {numbers.data && (
                <Badge bg="rgba(13,150,104,0.16)" fg="var(--accent)">
                  {live} {plural(live, 'номер на связи', 'номера на связи', 'номеров на связи')}
                </Badge>
              )}
            </div>
            <div
              style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.45 }}
            >
              Подключение по QR-коду: продавец сканирует его в своём WhatsApp, и переписки этого
              номера начинают попадать в разбор.
            </div>
          </div>
          <button
            type="button"
            className="btn-accent"
            style={{ marginLeft: 'auto', flex: '0 0 auto' }}
            onClick={startQr}
            disabled={Boolean(session)}
          >
            {session ? 'QR-код показан ниже' : 'Подключить номер по QR'}
          </button>
        </div>

        {session && (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'auto 1fr',
              gap: 24,
              padding: '20px 19px',
              borderBottom: '1px solid var(--line-soft)',
              alignItems: 'start',
            }}
          >
            <div
              style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 11 }}
            >
              <QrCode seed={seedOf(session.payload || session.sessionId)} />
              <div className="mono" style={{ fontSize: 10.5, color: 'var(--text-dim)' }}>
                Код действует {session.expiresInSeconds} секунд
              </div>
              <button type="button" className="btn" onClick={startQr}>
                Обновить код
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
              <div>
                <div style={{ fontSize: 13.5, fontWeight: 700, marginBottom: 12 }}>
                  Как подключить номер
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
                  {WHATSAPP_STEPS.map((label, i) => (
                    <div key={label} style={{ display: 'flex', alignItems: 'flex-start', gap: 11 }}>
                      <span
                        className="mono"
                        style={{
                          flex: '0 0 auto',
                          width: 20,
                          height: 20,
                          borderRadius: 6,
                          background: 'var(--raise)',
                          border: '1px solid var(--line-3)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: 10.5,
                          fontWeight: 700,
                          color: 'var(--text-muted)',
                        }}
                      >
                        {i + 1}
                      </span>
                      <span
                        className="pretty"
                        style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--text-2)' }}
                      >
                        {label}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 11,
                  padding: '12px 14px',
                  borderRadius: 11,
                  background: 'var(--sunken)',
                  border: '1px solid var(--line-2)',
                }}
              >
                <LiveDot size={7} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 600 }}>Ждём сканирования</div>
                  <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>
                    Номер появится в списке ниже сразу после подтверждения на телефоне
                  </div>
                </div>
                <button
                  type="button"
                  className="btn-quiet"
                  style={{ flex: '0 0 auto' }}
                  onClick={() => closeQr()}
                >
                  Отменить
                </button>
              </div>

              <div
                className="pretty"
                style={{ fontSize: 11, lineHeight: 1.5, color: 'var(--text-dim)' }}
              >
                Читаются только чаты этого номера с клиентами. Личные переписки, группы и архив до
                подключения Ракурс не забирает — продавец может отключить номер в любой момент.
              </div>
            </div>
          </div>
        )}

        {numbers.error && !numbers.data ? (
          <ErrorState error={numbers.error} onRetry={numbers.reload} compact />
        ) : !numbers.data ? (
          <RowsSkeleton rows={4} height={52} />
        ) : (
          allNumbers.map((n) => (
            <div
              key={n.phone}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 14,
                padding: '14px 19px',
                borderBottom: '1px solid var(--line-soft)',
              }}
            >
              <span
                style={{
                  width: 7,
                  height: 7,
                  flex: '0 0 auto',
                  borderRadius: '50%',
                  background: n.dot,
                }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="mono" style={{ fontSize: 12.5, fontWeight: 600 }}>
                  {n.phone}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 3 }}>{n.owner}</div>
              </div>
              <div style={{ flex: '0 0 120px', textAlign: 'right' }}>
                <div className="mono" style={{ fontSize: 12, color: 'var(--text-3)' }}>
                  {n.dialogs}
                </div>
                <div style={{ fontSize: 10.5, color: 'var(--text-dim)', marginTop: 3 }}>
                  диалогов
                </div>
              </div>
              <div style={{ flex: '0 0 150px', textAlign: 'right' }}>
                <div style={{ fontSize: 11.5, color: n.statusFg }}>{n.status}</div>
                <div style={{ fontSize: 10.5, color: 'var(--text-dim)', marginTop: 3 }}>
                  {n.since}
                </div>
              </div>
              <button
                type="button"
                className="btn-sm"
                style={{ flex: '0 0 auto' }}
                onClick={async () => {
                  if (n.action === 'Отключить') {
                    try {
                      await api.disconnectNumber(n.phone);
                      numbers.reload();
                      toast.ok(`Номер ${n.phone} отключён`);
                    } catch (e) {
                      toast.fail(e, 'Не удалось отключить номер');
                    }
                  } else {
                    startQr();
                  }
                }}
              >
                {n.action}
              </button>
            </div>
          ))
        )}
      </div>

      <Async
        state={integrations}
        compactError
        skeleton={
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 16 }}>
            <div className="card" style={{ height: 150 }} />
            <div className="card" style={{ height: 150 }} />
          </div>
        }
      >
        {(list) =>
          list.length ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 16 }}>
              {list.map((i) => (
                <Card
                  key={i.name}
                  style={{ padding: '17px 19px', display: 'flex', flexDirection: 'column', gap: 13 }}
                  pad={false}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: '50%',
                        background: toneColor(i.state),
                      }}
                    />
                    <div style={{ fontSize: 13.5, fontWeight: 600 }}>{i.name}</div>
                    <span
                      style={{
                        marginLeft: 'auto',
                        fontSize: 11,
                        fontWeight: 700,
                        color: toneColor(i.state),
                      }}
                    >
                      {i.status}
                    </span>
                  </div>
                  <div
                    className="pretty"
                    style={{ fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-muted)' }}
                  >
                    {i.description}
                  </div>
                  <div
                    style={{ display: 'flex', flexDirection: 'column', gap: 7, marginTop: 'auto' }}
                  >
                    {i.rows.map((r) => (
                      <div
                        key={r.k}
                        style={{
                          display: 'flex',
                          alignItems: 'baseline',
                          justifyContent: 'space-between',
                          gap: 10,
                        }}
                      >
                        <span style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>{r.k}</span>
                        <span className="mono" style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
                          {r.v}
                        </span>
                      </div>
                    ))}
                  </div>
                </Card>
              ))}
            </div>
          ) : (
            <div className="card">
              <EmptyState>Других интеграций не подключено</EmptyState>
            </div>
          )
        }
      </Async>

    </Screen>
  );
}
