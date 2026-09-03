# Task 9: The integrations screen

Part of [WhatsApp Coexistence](2026-09-04-whatsapp-coexistence.md). Depends on Task 5.

**Files:**
- Create: `rakurs/src/lib/embedded-signup.ts`
- Modify: `rakurs/src/api/index.ts` (two calls), `rakurs/src/screens/IntegrationsScreen.tsx`
- Verify: `npm --prefix rakurs run typecheck && npm --prefix rakurs run build`

**Interfaces:**
- Consumes: `GET /agents/:id/whatsapp/embedded-signup` → `EmbeddedSignupSetup`, `POST /agents/:id/whatsapp/coexistence` (body `CoexistenceConnection`) → `WhatsappNumber`; `WhatsappNumber.connectionKind / historyProgress / historyDeclined / syncError / offboarded`.
- Produces: `runCoexistenceSignup(setup: EmbeddedSignupSetup): Promise<CoexistenceConnection>` — resolves once Meta has handed back both the code and the session data, rejects with a Russian message on cancel or error.

No unit tests in `rakurs/`; the checks are typecheck, build, and the live flow on `rop.tasbaqa.ru`.

- [ ] **Step 1: API calls**

In `rakurs/src/api/index.ts`, next to the WhatsApp calls (add `CoexistenceConnection, EmbeddedSignupSetup` to the type import from `@/types`, which re-exports the contract):

```ts
export const getEmbeddedSignupSetup = (agentId: string, signal?: AbortSignal) =>
  request<EmbeddedSignupSetup>(`/agents/${agentId}/whatsapp/embedded-signup`, { signal });

export const connectCoexistenceNumber = (agentId: string, body: CoexistenceConnection) =>
  request<WhatsappNumber>(`/agents/${agentId}/whatsapp/coexistence`, { method: 'POST', body });
```

Check `rakurs/src/types/index.ts` re-exports everything from the contract (`export * from '@rakurs/contract'` or a named list); add the two names if it is a named list.

- [ ] **Step 2: The signup runner**

Create `rakurs/src/lib/embedded-signup.ts`:

```ts
import type { CoexistenceConnection, EmbeddedSignupSetup } from '@/types';

/** Pinned to what the server talks; the SDK refuses a version it has retired. */
const GRAPH_VERSION = 'v26.0';
const SDK_URL = 'https://connect.facebook.net/en_US/sdk.js';

/** The slice of Meta's SDK this file uses. Not the whole surface, on purpose. */
interface FacebookSdk {
  init(options: { appId: string; autoLogAppEvents: boolean; xfbml: boolean; version: string }): void;
  login(
    callback: (response: { authResponse?: { code?: string }; status?: string }) => void,
    options: {
      config_id: string;
      response_type: 'code';
      override_default_response_type: true;
      extras: { setup: Record<string, never>; featureType: string; sessionInfoVersion: string };
    },
  ): void;
}

declare global {
  interface Window {
    FB?: FacebookSdk;
    fbAsyncInit?: () => void;
  }
}

let loading: Promise<FacebookSdk> | null = null;

/** Loads Meta's SDK once. A second call while the first is in flight shares the promise. */
function loadSdk(appId: string): Promise<FacebookSdk> {
  if (window.FB) return Promise.resolve(window.FB);
  if (loading) return loading;
  loading = new Promise<FacebookSdk>((resolve, reject) => {
    window.fbAsyncInit = () => {
      window.FB!.init({ appId, autoLogAppEvents: true, xfbml: true, version: GRAPH_VERSION });
      resolve(window.FB!);
    };
    const script = document.createElement('script');
    script.src = SDK_URL;
    script.async = true;
    script.defer = true;
    script.crossOrigin = 'anonymous';
    script.onerror = () => {
      loading = null;
      reject(new Error('Не удалось загрузить скрипт Meta. Проверьте блокировщик рекламы.'));
    };
    document.head.appendChild(script);
  });
  return loading;
}

/**
 * Runs Meta's Embedded Signup for a number that lives in the WhatsApp Business app.
 *
 * Meta answers on two channels: the login callback carries the `code`, and a `message`
 * event from facebook.com carries the session data (WABA id, sometimes the phone number id).
 * Both are needed, in either order; the promise settles once both are in. The code lives
 * thirty seconds, so the caller must post it to the server immediately.
 */
export function runCoexistenceSignup(setup: EmbeddedSignupSetup): Promise<CoexistenceConnection> {
  return loadSdk(setup.appId).then(
    (fb) =>
      new Promise<CoexistenceConnection>((resolve, reject) => {
        let code: string | null = null;
        let session: Omit<CoexistenceConnection, 'code'> | null = null;

        const settle = () => {
          if (code && session) {
            window.removeEventListener('message', onMessage);
            resolve({ code, ...session });
          }
        };

        const onMessage = (event: MessageEvent) => {
          if (typeof event.origin !== 'string' || !event.origin.endsWith('facebook.com')) return;
          let data: {
            type?: string;
            event?: string;
            data?: { waba_id?: string; phone_number_id?: string; business_id?: string; error_message?: string };
          };
          try {
            data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
          } catch {
            return;
          }
          if (data?.type !== 'WA_EMBEDDED_SIGNUP') return;

          if (data.event === 'CANCEL' || data.event === 'ERROR') {
            window.removeEventListener('message', onMessage);
            reject(new Error(data.data?.error_message ?? 'Подключение отменено'));
            return;
          }
          if (data.data?.waba_id) {
            session = {
              wabaId: data.data.waba_id,
              phoneNumberId: data.data.phone_number_id,
              businessId: data.data.business_id,
            };
            settle();
          }
        };
        window.addEventListener('message', onMessage);

        fb.login(
          (response) => {
            if (response.authResponse?.code) {
              code = response.authResponse.code;
              settle();
            } else if (!session) {
              window.removeEventListener('message', onMessage);
              reject(new Error('Meta не вернула код подтверждения'));
            }
          },
          {
            config_id: setup.configId,
            response_type: 'code',
            override_default_response_type: true,
            extras: {
              setup: {},
              featureType: 'whatsapp_business_app_onboarding',
              sessionInfoVersion: '3',
            },
          },
        );
      }),
  );
}
```

- [ ] **Step 3: Two cards**

In `rakurs/src/screens/IntegrationsScreen.tsx`:

Add the import `import { runCoexistenceSignup } from '@/lib/embedded-signup';`.

Replace `{owner && <ConnectForm agentId={agent.id} onConnected={query.reload} />}` with:

```tsx
          {owner && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
              <PhoneNumberCard agentId={agent.id} onConnected={query.reload} />
              <ConnectForm agentId={agent.id} onConnected={query.reload} />
            </div>
          )}
```

In `ConnectForm`, change the heading to «Отдельный номер» and the hint to:

```
Номер, которого нет в WhatsApp на телефоне. Значения берутся в Meta: WhatsApp → API Setup. Токен — постоянный, от системного пользователя.
```

Add the new card after `ConnectForm`:

```tsx
/**
 * Подключение номера, который уже живёт в WhatsApp Business на телефоне.
 *
 * Окно открывает Meta; кабинет получает код и данные сессии и сразу отдаёт их серверу —
 * код живёт тридцать секунд. Сам сервер обменивает код на токен, подписывает приложение
 * и запрашивает у Meta контакты и историю. Всё, что здесь может пойти не так, приходит
 * текстом с сервера и показывается как есть.
 */
function PhoneNumberCard({ agentId, onConnected }: { agentId: string; onConnected: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function connect() {
    setBusy(true);
    try {
      const setup = await api.getEmbeddedSignupSetup(agentId);
      const connection = await runCoexistenceSignup(setup);
      await api.connectCoexistenceNumber(agentId, connection);
      toast.ok('Номер подключён. Контакты и история подтянутся в течение нескольких минут.');
      onConnected();
    } catch (error) {
      toast.fail(error);
    } finally {
      setBusy(false);
    }
  }

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
        <div>
          <button type="button" className="btn" disabled={busy} onClick={connect}>
            {busy ? 'Ждём Meta…' : 'Подключить через Meta'}
          </button>
        </div>
      </div>
    </Card>
  );
}
```

- [ ] **Step 4: The numbers list**

In `ConnectedNumbers`, under the `ID номера` hint, add:

```tsx
              <div style={hint}>
                {number.connectionKind === 'coexistence' ? 'Номер с телефона' : 'Отдельный номер'}
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
              {number.offboarded && (
                <div style={{ ...hint, color: 'var(--danger)' }}>
                  Телефон отключил API. Подключите заново на телефоне: Настройки → Аккаунт →
                  Business Platform.
                </div>
              )}
```

Change the `ReplaceToken` line to render only for manual numbers:

```tsx
          {owner && number.connectionKind === 'manual' && (
            <ReplaceToken agentId={agentId} number={number} onReplaced={onChanged} />
          )}
```

Change the delete confirmation for coexistence numbers so the owner knows the phone is unaffected: prefix the `window.confirm` text with `number.connectionKind === 'coexistence' ? 'Телефон при этом не отключается — это делается на самом телефоне. ' : ''`.

Update the `WebhookCard` hint to list the fields:

```
Вставьте это в настройках приложения Meta: WhatsApp → Configuration → Webhook. Затем подпишитесь на поля messages, smb_message_echoes, smb_app_state_sync, history и account_update.
```

- [ ] **Step 5: Verify**

```bash
npm --prefix rakurs run typecheck
npm --prefix rakurs run build
```

Expected: both clean. Then, on `rop.tasbaqa.ru` with the env from Task 2 filled in, press «Подключить через Meta» as the app admin: Meta's window must offer «Подключить приложение WhatsApp Business» (that screen is Meta's own confirmation that `featureType` was accepted). If instead it shows the WABA picker, the Login for Business configuration or the `featureType` key is wrong; try the snake_case `feature_type` key as a second attempt, since Meta's docs disagree with themselves.

- [ ] **Step 6: Commit**

```bash
git add rakurs/src/lib/embedded-signup.ts rakurs/src/api/index.ts rakurs/src/screens/IntegrationsScreen.tsx rakurs/src/types
git commit -m "Offer the phone's WhatsApp number as a connection on the integrations screen"
```
