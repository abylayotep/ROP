import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { toCanvas } from 'qrcode';
import { Link } from 'react-router-dom';
import * as api from '@/api';
import { CapiEventRow } from '@/components/capi/EventRow';
import { Card, CardHead, Toggle } from '@/components/ui/primitives';
import { Async, EmptyState, RowsSkeleton, Skeleton } from '@/components/ui/states';
import { useToast } from '@/components/ui/Toast';
import { useApi } from '@/hooks/useApi';
import { runCoexistenceSignup } from '@/lib/embedded-signup';
import { numbersToRenew, tokenDeadline } from '@/lib/whatsapp-token';
import { useAgent } from '@/store/agent';
import type {
  CapiEvent,
  CapiSettings,
  LinkedPairingEvent,
  WebhookSetup,
  WhatsappNumber,
} from '@/types';

/** Where an owner takes the dataset id and the token. Linked rather than described twice. */
const EVENTS_MANAGER_URL = 'https://business.facebook.com/events_manager2';

const field: CSSProperties = {
  width: '100%',
  maxWidth: 460,
  padding: '10px 12px',
  marginTop: 6,
  background: 'var(--sunken)',
  color: 'var(--text)',
  border: '1px solid var(--line)',
  borderRadius: 8,
  font: 'inherit',
  outline: 'none',
};

const label: CSSProperties = { fontSize: 12.5, color: 'var(--text-dim)' };
const hint: CSSProperties = { fontSize: 11.5, color: 'var(--text-dim)', marginTop: 4 };

const when = (iso: string) =>
  new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

interface Loaded {
  numbers: WhatsappNumber[];
  setup: WebhookSetup | null;
}

export function IntegrationsScreen() {
  const { agent, role } = useAgent();
  const owner = role === 'owner';

  const query = useApi<Loaded>(
    async (signal) => ({
      numbers: await api.listWhatsappNumbers(agent.id, signal),
      // The verification string is a shared secret, so the server shows it to owners only.
      setup: owner ? await api.getWebhookSetup(agent.id, signal) : null,
    }),
    [agent.id, owner],
  );

  return (
    <Async state={query} skeleton={<Skeleton height={200} />}>
      {({ numbers, setup }) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Above everything, including the numbers themselves: the sixty-day token is
              the one failure that arrives on a working cabinet with no warning at all. */}
          <TokenRenewalCard numbers={numbers} owner={owner} agentId={agent.id} onChanged={query.reload} />
          <ConnectedNumbers
            numbers={numbers}
            owner={owner}
            onChanged={query.reload}
            agentId={agent.id}
          />
          {owner && setup && <WebhookCard setup={setup} />}
          {owner && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
              <PhoneNumberCard agentId={agent.id} onConnected={query.reload} />
              <LinkedPhoneCard agentId={agent.id} onConnected={query.reload} />
              <ConnectForm agentId={agent.id} onConnected={query.reload} />
            </div>
          )}
          {!owner && numbers.length === 0 && (
            <Card>
              <EmptyState>Номер подключает владелец компании.</EmptyState>
            </Card>
          )}
          {/* Beside the number it depends on: a purchase can only be attributed to a click
              that arrived on this WhatsApp number, and the two are set up together. */}
          <CapiSection agentId={agent.id} owner={owner} />
        </div>
      )}
    </Async>
  );
}

// Module scope, not nested inside IntegrationsScreen: a function declared inside a
// component's body gets a new identity every render, so React would treat each render as a
// different component type and unmount/remount it — wiping ConnectForm's typed fields and
// input focus every time query.reload() runs after a toggle or a disconnect.

function ConnectedNumbers({
  numbers,
  owner,
  agentId,
  onChanged,
}: {
  numbers: WhatsappNumber[];
  owner: boolean;
  agentId: string;
  onChanged: () => void;
}) {
  const toast = useToast();

  if (numbers.length === 0) return null;

  return (
    <Card>
      <div style={{ fontSize: 13.5, fontWeight: 650, marginBottom: 12 }}>
        Подключённые номера
      </div>
      {numbers.map((number) => (
        <div
          key={number.id}
          style={{ padding: '10px 0', borderTop: '1px solid var(--line-soft)' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13.5 }}>{number.displayPhone}</div>
              {number.phoneNumberId ? (
                <div style={hint}>ID номера {number.phoneNumberId}</div>
              ) : null}
              <div style={hint}>
                {number.connectionKind === 'coexistence'
                  ? 'Номер с телефона'
                  : number.connectionKind === 'linked'
                    ? 'Телефон по QR'
                    : 'Отдельный номер'}
              </div>
              {number.connectionKind === 'coexistence' && number.syncError && (
                <div style={{ ...hint, color: 'var(--danger)' }}>
                  Meta не приняла запрос контактов и истории: {number.syncError}
                </div>
              )}
              {number.connectionKind === 'coexistence' && !number.syncError && (
                <div style={hint}>
                  {number.historyDeclined
                    ? 'Владелец выключил передачу истории на телефоне.'
                    : number.historyProgress >= 100
                      ? 'История импортирована.'
                      : `Импорт истории: ${number.historyProgress} %`}
                </div>
              )}
              {number.connectionKind === 'coexistence' && number.offboarded && (
                <div style={{ ...hint, color: 'var(--danger)' }}>
                  Телефон отключил API. Подключите заново на телефоне: Настройки → Аккаунт →
                  Business Platform.
                </div>
              )}
              <TokenDeadlineLine number={number} />
              {number.connectionKind === 'linked' && number.linkedState === 'logged_out' && (
                <div style={{ ...hint, color: 'var(--danger)' }}>
                  Телефон отвязал кабинет — подключите заново по QR.
                </div>
              )}
              {number.connectionKind === 'linked' && number.linkedState === 'pairing' && (
                <div style={hint}>Ждём сканирования кода.</div>
              )}
              {/* The failure this line exists for: Meta took the number and delivers
                  nothing, which looks identical to working until a client writes. A phone
                  paired by QR has no WABA and no subscription to be missing. */}
              {number.connectionKind !== 'linked' && !number.subscribed && (
                <div style={{ ...hint, color: 'var(--danger)' }}>
                  Приложение не подписано на WABA — сообщения приходить не будут.
                </div>
              )}
            </div>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
              <span style={{ ...hint, marginTop: 0 }}>
                {number.enabled ? 'Включён' : 'Выключен'}
              </span>
              {owner && (
                <>
                  <button
                    type="button"
                    className="btn"
                    onClick={async () => {
                      try {
                        await api.setWhatsappNumberEnabled(agentId, number.id, !number.enabled);
                        onChanged();
                      } catch (error) {
                        toast.fail(error);
                      }
                    }}
                  >
                    {number.enabled ? 'Выключить' : 'Включить'}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={async () => {
                      // Удаление уносит переписки, сообщения и данные о рекламе, из
                      // которой пришли клиенты. Meta их второй раз не отдаст.
                      if (
                        !window.confirm(
                          (number.connectionKind === 'coexistence'
                            ? 'Телефон при этом не отключается — это делается на самом телефоне. '
                            : '') +
                            'Отключить номер? Вместе с ним удалятся все переписки, сообщения и данные о рекламе, ' +
                            'из которой пришли клиенты. Это нельзя отменить.',
                        )
                      ) {
                        return;
                      }
                      try {
                        await api.disconnectWhatsappNumber(agentId, number.id);
                        toast.ok('Номер удалён');
                        onChanged();
                      } catch (error) {
                        toast.fail(error);
                      }
                    }}
                  >
                    Удалить номер
                  </button>
                </>
              )}
            </div>
          </div>
          {owner && number.connectionKind === 'linked' && number.linkedState !== 'logged_out' && (
            <div style={{ marginTop: 8 }}>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={async () => {
                  try {
                    await api.unlinkPhone(agentId, number.id);
                    toast.ok('Телефон отключён. Переписка осталась в кабинете.');
                    onChanged();
                  } catch (error) {
                    toast.fail(error);
                  }
                }}
              >
                Отключить телефон
              </button>
            </div>
          )}
          {owner && number.connectionKind === 'manual' && (
            <ReplaceToken agentId={agentId} number={number} onReplaced={onChanged} />
          )}
        </div>
      ))}
    </Card>
  );
}

/**
 * Замена протухшего токена.
 *
 * Временный токен Meta живёт сутки, и без этой формы единственным способом поставить
 * новый было бы удалить номер — вместе со всеми диалогами и рекламной атрибуцией.
 */
function ReplaceToken({
  agentId,
  number,
  onReplaced,
}: {
  agentId: string;
  number: WhatsappNumber;
  onReplaced: () => void;
}) {
  const toast = useToast();

  const [open, setOpen] = useState(false);
  const [accessToken, setAccessToken] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await api.replaceWhatsappToken(agentId, number.id, accessToken);
      // Очищается только на успехе: токен, который Meta не приняла, стоит оставить на
      // экране, чтобы его можно было поправить, а не вставлять заново.
      setAccessToken('');
      setOpen(false);
      toast.ok('Токен обновлён');
      onReplaced();
    } catch (error) {
      toast.fail(error);
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        className="btn"
        style={{ marginTop: 8 }}
        onClick={() => setOpen(true)}
      >
        Обновить токен
      </button>
    );
  }

  return (
    <form onSubmit={submit} style={{ marginTop: 8 }}>
      <div style={label}>Новый токен доступа</div>
      <input
        style={field}
        type="password"
        value={accessToken}
        onChange={(e) => setAccessToken(e.target.value)}
      />
      <div style={hint}>
        Проверяется в Meta до сохранения. Переписки и данные о рекламе остаются на месте.
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button type="submit" className="btn" disabled={saving || !accessToken}>
          {saving ? 'Проверяем…' : 'Сохранить токен'}
        </button>
        <button type="button" className="btn" onClick={() => setOpen(false)}>
          Отмена
        </button>
      </div>
    </form>
  );
}

function WebhookCard({ setup }: { setup: WebhookSetup }) {
  return (
    <Card>
      <div style={{ fontSize: 13.5, fontWeight: 650, marginBottom: 8 }}>Вебхук в Meta</div>
      <div style={hint}>
        Вставьте это в настройках приложения Meta: WhatsApp → Configuration → Webhook. Затем
        подпишитесь на поля messages, smb_message_echoes, smb_app_state_sync, history и
        account_update. Весь путь по шагам — в разделе{' '}
        <Link to="../setup">«Запуск»</Link>.
      </div>
      <div style={{ marginTop: 10 }}>
        <div style={label}>Callback URL</div>
        <div className="mono" style={{ ...field, marginTop: 6 }}>
          {setup.url}
        </div>
      </div>
      <div style={{ marginTop: 10 }}>
        <div style={label}>Verify token</div>
        <div className="mono" style={{ ...field, marginTop: 6 }}>
          {setup.verifyToken}
        </div>
      </div>
    </Card>
  );
}

function ConnectForm({ agentId, onConnected }: { agentId: string; onConnected: () => void }) {
  const toast = useToast();

  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [wabaId, setWabaId] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await api.connectWhatsappNumber(agentId, { phoneNumberId, wabaId, accessToken });
      // Cleared on success only: a token that Meta rejected is worth keeping on screen
      // so it can be corrected rather than pasted again.
      setPhoneNumberId('');
      setWabaId('');
      setAccessToken('');
      toast.ok('Номер подключён');
      onConnected();
    } catch (error) {
      toast.fail(error);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ fontSize: 13.5, fontWeight: 650 }}>Отдельный номер</div>
        <div style={hint}>
          Номер, которого нет в WhatsApp на телефоне. Значения берутся в Meta: WhatsApp → API
          Setup. Токен — постоянный, от системного пользователя. Где именно их взять и что
          нажать в Meta — по шагам в разделе <Link to="../setup">«Запуск»</Link>.
        </div>

        <div>
          <div style={label}>Phone number ID</div>
          <input
            style={field}
            value={phoneNumberId}
            onChange={(e) => setPhoneNumberId(e.target.value)}
          />
        </div>
        <div>
          <div style={label}>WhatsApp Business Account ID</div>
          <input style={field} value={wabaId} onChange={(e) => setWabaId(e.target.value)} />
        </div>
        <div>
          <div style={label}>Токен доступа</div>
          <input
            style={field}
            type="password"
            value={accessToken}
            onChange={(e) => setAccessToken(e.target.value)}
          />
          <div style={hint}>Хранится в зашифрованном виде и обратно не показывается.</div>
        </div>

        <div>
          <button type="submit" className="btn" disabled={saving}>
            {saving ? 'Проверяем…' : 'Подключить'}
          </button>
        </div>
      </form>
    </Card>
  );
}

/**
 * Строка о сроке доступа Meta под самим номером.
 *
 * Said on the row as well as in the card above the list: an owner with two numbers has to
 * know which of them is the one about to go quiet.
 */
function TokenDeadlineLine({ number }: { number: WhatsappNumber }) {
  const deadline = tokenDeadline(number);
  if (deadline.note === '') return null;

  return (
    <div
      style={{
        ...hint,
        color: deadline.state === 'expired' ? 'var(--danger)' : 'var(--warn)',
      }}
    >
      {deadline.note}
    </div>
  );
}

/**
 * Кнопка, которая открывает окно Meta, — одна на подключение и на продление.
 *
 * Renewing a token is the same Embedded Signup run against the same number: Meta issues a
 * new one and the server writes it over the old row. Two buttons doing the same thing
 * would be two places to fix when Meta changes the window.
 */
function CoexistenceButton({
  agentId,
  onConnected,
  label,
  done,
}: {
  agentId: string;
  onConnected: () => void;
  label: string;
  done: string;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function connect() {
    setBusy(true);
    try {
      const setup = await api.getEmbeddedSignupSetup(agentId);
      const connection = await runCoexistenceSignup(setup);
      await api.connectCoexistenceNumber(agentId, connection);
      toast.ok(done);
      onConnected();
    } catch (error) {
      toast.fail(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button type="button" className="btn" disabled={busy} onClick={connect}>
      {busy ? 'Ждём Meta…' : label}
    </button>
  );
}

/**
 * Предупреждение о токене Meta, который скоро закончится или уже закончился.
 *
 * Meta issues the cabinet's tokens from a configuration built on the «60-day token»
 * template, and there is no refresh call: a permanent token needs Tech Provider status,
 * which this application does not have. So the deadline is real, it arrives for every
 * connected number at once, and nothing about a working cabinet hints at it. This card is
 * the hint — it appears two weeks out and stays until somebody presses the button.
 */
function TokenRenewalCard({
  numbers,
  owner,
  agentId,
  onChanged,
}: {
  numbers: WhatsappNumber[];
  owner: boolean;
  agentId: string;
  onChanged: () => void;
}) {
  const pending = numbersToRenew(numbers);
  if (pending.length === 0) return null;

  const expired = pending.filter((entry) => entry.deadline.state === 'expired');

  return (
    <Card>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div
          style={{
            fontSize: 13.5,
            fontWeight: 650,
            color: expired.length > 0 ? 'var(--danger)' : 'var(--warn)',
          }}
        >
          {expired.length > 0
            ? 'Доступ Meta к номеру истёк'
            : 'Доступ Meta к номеру скоро закончится'}
        </div>
        {pending.map((entry) => (
          <div key={entry.number.id} style={{ fontSize: 13 }}>
            {entry.number.displayPhone} — {entry.deadline.note}
          </div>
        ))}
        <div style={hint}>
          Meta выдаёт кабинету доступ к номеру на 60 дней. Продлить его можно только тем же
          окном Meta, что и при подключении: переписки, клиенты и настройки остаются на
          месте.
        </div>
        {owner ? (
          <div>
            <CoexistenceButton
              agentId={agentId}
              onConnected={onChanged}
              label="Подключить номер заново"
              done="Доступ продлён. Переписки и настройки остались на месте."
            />
          </div>
        ) : (
          <div style={hint}>Продлевает доступ владелец компании.</div>
        )}
      </div>
    </Card>
  );
}

/**
 * Подключение номера, который уже живёт в WhatsApp Business на телефоне.
 *
 * Окно открывает Meta; кабинет получает код и данные сессии и сразу отдаёт их серверу —
 * код живёт тридцать секунд. Сам сервер обменивает код на токен, подписывает приложение
 * и запрашивает у Meta контакты и историю. Всё, что здесь может пойти не так, приходит
 * текстом с сервера и показывается как есть.
 */
function PhoneNumberCard({ agentId, onConnected }: { agentId: string; onConnected: () => void }) {
  return (
    <Card>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ fontSize: 13.5, fontWeight: 650 }}>WhatsApp на телефоне</div>
        <div style={hint}>
          Номер остаётся в приложении WhatsApp Business: оператор отвечает с телефона, ИИ и
          кабинет работают в тех же чатах. Подтянутся контакты и история за 6 месяцев.
        </div>
        <ul style={{ ...hint, margin: 0, paddingLeft: 18 }}>
          <li>Номер уже зарегистрирован в приложении WhatsApp Business, не в обычном WhatsApp.</li>
          <li>Приложение на телефоне обновлено.</li>
          <li>Пока идёт импорт, телефон должен быть в сети.</li>
        </ul>
        <div style={hint}>
          Групповые чаты, звонки и рассылки из приложения в кабинет не попадают.
        </div>
        <div style={hint}>
          Meta выдаёт доступ к номеру на 60 дней. За две недели до конца кабинет напомнит
          продлить его — это то же окно Meta, переписки при этом остаются.
        </div>
        <div>
          <CoexistenceButton
            agentId={agentId}
            onConnected={onConnected}
            label="Подключить через Meta"
            done="Номер подключён. Контакты и история подтянутся в течение нескольких минут."
          />
        </div>
      </div>
    </Card>
  );
}

/**
 * Pairing a phone by QR, with the code redrawn as WhatsApp reissues it.
 *
 * An `EventSource` rather than polling: the server already has the codes as they arrive,
 * and a poll would show a code that has expired between two requests. The warning under
 * the button is not decoration — the owner chose this connection knowing what it risks,
 * and the next person to open this screen did not.
 */
function LinkedPhoneCard({ agentId, onConnected }: { agentId: string; onConnected: () => void }) {
  const toast = useToast();
  const [numberId, setNumberId] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canvas = useRef<HTMLCanvasElement | null>(null);

  // Redrawn on every code. The canvas only exists while pairing, so the guard is not
  // defensive — it is the first render after `qr` is set, before the ref is attached.
  useEffect(() => {
    if (!qr || !canvas.current) return;
    void toCanvas(canvas.current, qr, { width: 232, margin: 1 }).catch(() => undefined);
  }, [qr]);

  useEffect(() => {
    if (!numberId) return;
    const source = new EventSource(api.linkedPairingStream(agentId, numberId), {
      withCredentials: true,
    });

    source.onmessage = (event) => {
      const payload = JSON.parse(event.data) as LinkedPairingEvent;
      if (payload.type === 'qr') setQr(payload.qr);
      if (payload.type === 'open') {
        source.close();
        setNumberId(null);
        setQr(null);
        toast.ok('Телефон подключён.');
        onConnected();
      }
      if (payload.type === 'failed') {
        source.close();
        setNumberId(null);
        setQr(null);
        setFailure(payload.reason);
      }
    };

    // The stream ends itself on every settled outcome; this fires when the connection
    // drops instead. Saying nothing would leave a QR on screen that nobody is refreshing.
    source.onerror = () => {
      source.close();
      setNumberId(null);
      setQr(null);
      setFailure('Связь с сервером прервалась. Попробуйте ещё раз.');
    };

    return () => source.close();
  }, [agentId, numberId, onConnected, toast]);

  async function start() {
    setBusy(true);
    setFailure(null);
    try {
      const number = await api.startLinkedPairing(agentId);
      setNumberId(number.id);
    } catch (error) {
      toast.fail(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ fontSize: 13.5, fontWeight: 650 }}>Телефон по QR</div>

        {numberId ? (
          <>
            <div style={hint}>
              Откройте WhatsApp на телефоне → Настройки → Связанные устройства → Привязка
              устройства и наведите камеру на код.
            </div>
            <div style={{ display: 'flex', justifyContent: 'center', padding: 8 }}>
              {qr ? (
                <canvas ref={canvas} style={{ background: '#fff', borderRadius: 8 }} />
              ) : (
                <Skeleton height={232} />
              )}
            </div>
            <div style={hint}>Код обновляется каждые несколько секунд — это нормально.</div>
          </>
        ) : (
          <>
            <div style={hint}>
              Номер остаётся на телефоне и продолжает работать. Кабинет видит переписку,
              отвечает сам и показывает то, что вы написали с телефона.
            </div>
            {failure && <div style={{ ...hint, color: 'var(--danger)' }}>{failure}</div>}
            <div>
              <button type="button" className="btn" disabled={busy} onClick={start}>
                {busy ? 'Открываем…' : failure ? 'Попробовать снова' : 'Подключить телефон по QR'}
              </button>
            </div>
          </>
        )}

        <div style={{ ...hint, color: 'var(--danger)' }}>
          Неофициальное подключение: WhatsApp может заблокировать номер. Групповые чаты и
          звонки в кабинет не попадают, реклама без атрибуции.
        </div>
      </div>
    </Card>
  );
}

/* ── Meta Conversions API ──────────────────────────────────────────────────
 * Куда уходят покупки из переписки, и что с ними стало. */

/**
 * The settings and the log together, because they are one question.
 *
 * The settings are held in state rather than reread: `PUT` answers with the row as stored,
 * and that answer is what goes on screen. Reloading instead would show the previous values
 * for as long as the request took, which on this card means showing «токена нет» a moment
 * after one was saved.
 */
function CapiSection({ agentId, owner }: { agentId: string; owner: boolean }) {
  const query = useApi<CapiSettings>((signal) => api.getCapiSettings(agentId, signal), [agentId]);
  const [settings, setSettings] = useState<CapiSettings | null>(null);

  // Another agent's dataset must not sit under this agent's heading for even a frame.
  // Declared before the effect below so the two run in that order.
  useEffect(() => {
    setSettings(null);
  }, [agentId]);

  useEffect(() => {
    if (query.data) setSettings(query.data);
  }, [query.data]);

  return (
    <Async state={query} skeleton={<Skeleton height={220} />}>
      {() =>
        settings === null ? (
          <Skeleton height={220} />
        ) : (
          <>
            {owner ? (
              // Keyed on the agent so the drafts inside are seeded from that agent's row:
              // the form initialises its fields once, and switching agents is a different
              // form, not the same one with new props.
              <CapiForm
                key={agentId}
                agentId={agentId}
                settings={settings}
                onSaved={setSettings}
                onRemoved={query.reload}
              />
            ) : (
              <CapiState settings={settings} />
            )}
            <CapiLog agentId={agentId} />
          </>
        )
      }
    </Async>
  );
}

/** Что этот раздел делает и чего он не сделает — словами владельца, до всякой формы. */
function CapiIntro() {
  return (
    <>
      <div style={{ ...hint, marginTop: 0 }}>
        Покупки из переписки уходят в Meta, чтобы реклама искала похожих покупателей.
      </div>
      <div style={{ ...hint, marginTop: 6 }}>
        Отчёты уходят только по диалогам, которые начались с клика по рекламе
        Click-to-WhatsApp. Диалог, в котором клиент написал сам, отправить нельзя: Meta
        не с чем сопоставить покупку.
      </div>
    </>
  );
}

/** Строка состояния для сотрудника: настраивает владелец, но видеть должны все. */
function CapiState({ settings }: { settings: CapiSettings }) {
  const on = settings.enabled && settings.tokenSet;

  return (
    <Card>
      <CardHead
        title="Отправка покупок в Meta"
        gap={10}
        right={
          <span style={{ fontSize: 11.5, color: on ? 'var(--accent-2)' : 'var(--text-dim)' }}>
            {on ? 'Включена' : 'Выключена'}
          </span>
        }
      />
      <CapiIntro />
      <div style={{ ...hint, marginTop: 6 }}>Набор данных подключает владелец компании.</div>
    </Card>
  );
}

/**
 * Набор данных, токен и переключатель.
 *
 * Токен уходит на сервер и обратно не возвращается — экран знает только, есть он или нет,
 * ровно как с ключом OpenRouter и токеном WhatsApp. Пустое поле токена при сохранении
 * означает «оставить сохранённый»: владелец, который правит тестовый код или щёлкает
 * переключателем, не должен из-за этого лезть в Meta за токеном системного пользователя.
 *
 * Сервер проверяет пару в Meta до записи, поэтому «Сохранить» может занять секунду и
 * может вернуть отказ Meta целиком. Отказ ничего не перезаписывает: рабочая пара
 * остаётся на месте.
 */
function CapiForm({
  agentId,
  settings,
  onSaved,
  onRemoved,
}: {
  agentId: string;
  settings: CapiSettings;
  onSaved: (settings: CapiSettings) => void;
  onRemoved: () => void;
}) {
  const toast = useToast();

  const [datasetId, setDatasetId] = useState(settings.datasetId);
  const [accessToken, setAccessToken] = useState('');
  const [testEventCode, setTestEventCode] = useState(settings.testEventCode ?? '');
  const [saving, setSaving] = useState(false);

  const configured = settings.datasetId !== '' && settings.tokenSet;

  async function save(event: FormEvent) {
    event.preventDefault();
    if (saving || datasetId.trim() === '') return;

    setSaving(true);
    try {
      onSaved(
        await api.saveCapiSettings(agentId, {
          datasetId: datasetId.trim(),
          // Пустое поле — «оставить сохранённый токен». Для агента, у которого токена ещё
          // нет, сервер на это ответит «Укажите токен доступа», и это правильный ответ.
          accessToken: accessToken.trim() === '' ? undefined : accessToken.trim(),
          testEventCode: testEventCode.trim() === '' ? null : testEventCode.trim(),
        }),
      );
      // Очищается только на успехе: токен, который Meta не приняла, стоит оставить на
      // экране, чтобы его поправили, а не искали в Meta заново.
      setAccessToken('');
      toast.ok('Meta приняла набор данных');
    } catch (error) {
      toast.fail(error);
    } finally {
      setSaving(false);
    }
  }

  async function toggle() {
    if (saving) return;
    setSaving(true);
    try {
      onSaved(
        await api.saveCapiSettings(agentId, {
          datasetId: settings.datasetId,
          // Отправляется тем, что сохранено: отсутствие поля сервер понимает как «кода
          // нет» и стёр бы его заодно с переключением.
          testEventCode: settings.testEventCode,
          enabled: !settings.enabled,
        }),
      );
    } catch (error) {
      toast.fail(error);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (
      !window.confirm(
        'Убрать набор данных? Отчёты о покупках перестанут уходить в Meta, а те, ' +
          'что стоят в очереди, будут помечены как неотправленные.',
      )
    ) {
      return;
    }

    setSaving(true);
    try {
      await api.deleteCapiSettings(agentId);
      // Поля очищаются вместе с настройкой: оставленный в форме идентификатор набора
      // читался бы как «он ещё подключён», хотя рядом уже написано «Токена нет».
      setDatasetId('');
      setTestEventCode('');
      toast.ok('Набор данных убран');
      onRemoved();
    } catch (error) {
      toast.fail(error);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <form onSubmit={save}>
        <CardHead
          title="Отправка покупок в Meta"
          gap={10}
          right={
            <span
              style={{
                fontSize: 11.5,
                color: settings.tokenSet ? 'var(--accent-2)' : 'var(--text-dim)',
              }}
            >
              {settings.tokenSet ? 'Токен сохранён' : 'Токена нет'}
            </span>
          }
        />

        <CapiIntro />

        <div style={{ marginTop: 12 }}>
          <div style={label}>Идентификатор набора данных</div>
          <input
            style={field}
            value={datasetId}
            autoComplete="off"
            placeholder="1234567890123456"
            onChange={(e) => setDatasetId(e.target.value)}
          />
          <div style={hint}>
            Берётся в{' '}
            <a href={EVENTS_MANAGER_URL} target="_blank" rel="noreferrer">
              Meta Events Manager
            </a>
            : Data sources → набор данных → Settings. Как это сделать по шагам — в разделе{' '}
            <Link to="../setup">«Запуск»</Link>.
          </div>
        </div>

        <div style={{ marginTop: 12 }}>
          <div style={label}>Токен доступа</div>
          <input
            style={field}
            type="password"
            value={accessToken}
            autoComplete="off"
            placeholder={settings.tokenSet ? 'Введите новый токен, чтобы заменить' : 'EAAG…'}
            onChange={(e) => setAccessToken(e.target.value)}
          />
          <div style={hint}>
            Постоянный токен системного пользователя с правом на этот набор данных.
            Хранится в зашифрованном виде и обратно не показывается.
          </div>
        </div>

        <div style={{ marginTop: 12 }}>
          <div style={label}>Тестовый код события — необязательно</div>
          <input
            style={field}
            value={testEventCode}
            autoComplete="off"
            placeholder="TEST12345"
            onChange={(e) => setTestEventCode(e.target.value)}
          />
          <div style={hint}>
            Пока он указан, события видны во вкладке Test Events и не идут в оптимизацию
            рекламы. Уберите его, когда проверите, что события доходят.
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          <button type="submit" className="btn" disabled={saving || datasetId.trim() === ''}>
            {saving ? 'Проверяем в Meta…' : configured ? 'Сохранить' : 'Подключить'}
          </button>
          {configured && (
            <button type="button" className="btn" disabled={saving} onClick={remove}>
              Убрать набор данных
            </button>
          )}
        </div>

        {/* Проверка идёт до записи, поэтому эта дата означает: именно эта пара
            в этот момент была принята Meta, а не «когда-то что-то сохранили». */}
        {settings.verifiedAt && (
          <div style={{ ...hint, marginTop: 10 }}>
            Проверено в Meta {when(settings.verifiedAt)}.
          </div>
        )}
        {settings.error && (
          <div style={{ ...hint, color: 'var(--danger)', marginTop: 6 }}>{settings.error}</div>
        )}

        {configured && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              marginTop: 14,
              paddingTop: 12,
              borderTop: '1px solid var(--line-soft)',
            }}
          >
            <span style={{ fontSize: 12, fontWeight: 650 }}>Отправлять покупки в Meta</span>
            <button
              type="button"
              className="btn-quiet"
              aria-pressed={settings.enabled}
              disabled={saving}
              style={{ marginLeft: 'auto', display: 'flex', opacity: saving ? 0.5 : 1 }}
              onClick={toggle}
            >
              <Toggle on={settings.enabled} />
            </button>
          </div>
        )}
        {configured && (
          <div style={{ ...hint, marginTop: 6 }}>
            {settings.enabled
              ? 'Продажа уходит в Meta примерно за минуту после отметки об оплате.'
              : 'Пока выключено, продажи копятся в журнале с пометкой «Не отправлено».'}
          </div>
        )}
      </form>
    </Card>
  );
}

/**
 * Журнал: последние пятьдесят событий агента.
 *
 * Любому сотруднику, потому что заметит неотправленный отчёт тот, кто смотрит на лида, а
 * не владелец. Строка, отправленная заново, заменяется тем, чем ответил сервер.
 */
function CapiLog({ agentId }: { agentId: string }) {
  const query = useApi<CapiEvent[]>(
    (signal) => api.listCapiEvents(agentId, {}, signal),
    [agentId],
  );
  const [events, setEvents] = useState<CapiEvent[] | null>(null);

  // Same reason as above: the previous agent's log is an answer to a different question.
  useEffect(() => {
    setEvents(null);
  }, [agentId]);

  useEffect(() => {
    if (query.data) setEvents(query.data);
  }, [query.data]);

  return (
    <Card>
      <CardHead title="Что ушло в Meta" gap={10} />
      <Async state={query} skeleton={<RowsSkeleton rows={3} />}>
        {() =>
          // «Пока ничего не отправлялось» — утверждение о данных, а не состояние загрузки:
          // список копируется в состояние эффектом, то есть кадром позже, и без этой ветки
          // владелец успел бы увидеть эту фразу над непустым журналом.
          events === null ? (
            <RowsSkeleton rows={3} />
          ) : events.length === 0 ? (
            <EmptyState>
              Пока ничего не отправлялось. Событие появится здесь, когда заказ отметят
              оплаченным или лид дойдёт до квалифицирующей стадии.
            </EmptyState>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              {events.map((event) => (
                <CapiEventRow
                  key={event.id}
                  agentId={agentId}
                  event={event}
                  onResent={(next) =>
                    setEvents((rows) =>
                      (rows ?? []).map((row) => (row.id === next.id ? next : row)),
                    )
                  }
                />
              ))}
            </div>
          )
        }
      </Async>
    </Card>
  );
}
