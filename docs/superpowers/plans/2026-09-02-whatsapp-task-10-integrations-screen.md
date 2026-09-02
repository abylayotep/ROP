# Task 10: The integrations screen

Part of [WhatsApp Cloud API](2026-09-02-whatsapp-cloud-api.md).

Where an owner connects a number, and where they find out that a number is connected but silent.
The screen has one job beyond the form: making the subscription state visible, because a number
that Meta accepted without subscribing our application looks perfectly fine and never delivers
a message.

**Files:**
- Create: `rakurs/src/screens/IntegrationsScreen.tsx`
- Modify: `rakurs/src/api/index.ts`, `rakurs/src/App.tsx`, `rakurs/src/lib/sections.ts`

**Interfaces:**
- Consumes: contract types `WhatsappNumber` and `WebhookSetup` from task 8; `useAgent()`;
  `useToast()` with `ok(text)` and `fail(error, fallback?)`; `Async`, `Card`, `EmptyState`.
- Produces: nothing later tasks depend on.

---

- [ ] **Step 1: Add the calls**

In `rakurs/src/api/index.ts`, below the agent calls:

```ts
// ── WhatsApp ─────────────────────────────────────────────────────────────────

export const listWhatsappNumbers = (agentId: string, signal?: AbortSignal) =>
  request<WhatsappNumber[]>(`/agents/${agentId}/whatsapp/numbers`, { signal });

export const connectWhatsappNumber = (
  agentId: string,
  body: { phoneNumberId: string; wabaId: string; accessToken: string },
) => request<WhatsappNumber>(`/agents/${agentId}/whatsapp/numbers`, { method: 'POST', body });

export const setWhatsappNumberEnabled = (agentId: string, numberId: string, enabled: boolean) =>
  request<WhatsappNumber>(`/agents/${agentId}/whatsapp/numbers/${numberId}`, {
    method: 'PATCH',
    body: { enabled },
  });

export const disconnectWhatsappNumber = (agentId: string, numberId: string) =>
  request<{ ok: true }>(`/agents/${agentId}/whatsapp/numbers/${numberId}`, { method: 'DELETE' });

export const getWebhookSetup = (agentId: string, signal?: AbortSignal) =>
  request<WebhookSetup>(`/agents/${agentId}/whatsapp/setup`, { signal });
```

Extend the type import at the top to `import type { Agent, Me, WebhookSetup, WhatsappNumber } from '@/types';`.

- [ ] **Step 2: Write the screen**

Create `rakurs/src/screens/IntegrationsScreen.tsx` — the screens directory is flat, there is
no `sections/` subdirectory, and the other screens live beside each other:

```tsx
import { useState, type CSSProperties, type FormEvent } from 'react';
import * as api from '@/api';
import { Card } from '@/components/ui/primitives';
import { Async, EmptyState, Skeleton } from '@/components/ui/states';
import { useToast } from '@/components/ui/Toast';
import { useApi } from '@/hooks/useApi';
import { useAgent } from '@/store/agent';
import type { WebhookSetup, WhatsappNumber } from '@/types';

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

interface Loaded {
  numbers: WhatsappNumber[];
  setup: WebhookSetup | null;
}

export function IntegrationsScreen() {
  const { agent, role } = useAgent();
  const toast = useToast();
  const owner = role === 'owner';

  const query = useApi<Loaded>(
    async (signal) => ({
      numbers: await api.listWhatsappNumbers(agent.id, signal),
      // The verification string is a shared secret, so the server shows it to owners only.
      setup: owner ? await api.getWebhookSetup(agent.id, signal) : null,
    }),
    [agent.id, owner],
  );

  // The three cards below are declared at module scope, not inside this component. A
  // component defined during render gets a new identity every time, so React unmounts and
  // remounts it — and a reload after toggling a number would wipe whatever the owner had
  // typed into the connect form.
  return (
    <Async state={query} skeleton={<Skeleton height={200} />}>
      {({ numbers, setup }) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <ConnectedNumbers
            numbers={numbers}
            owner={owner}
            onChanged={query.reload}
            agentId={agent.id}
          />
          {owner && setup && <WebhookCard setup={setup} />}
          {owner && <ConnectForm agentId={agent.id} onConnected={query.reload} />}
          {!owner && numbers.length === 0 && (
            <Card>
              <EmptyState>Номер подключает владелец компании.</EmptyState>
            </Card>
          )}
        </div>
      )}
    </Async>
  );

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
    if (numbers.length === 0) return null;

    return (
      <Card>
        <div style={{ fontSize: 13.5, fontWeight: 650, marginBottom: 12 }}>
          Подключённые номера
        </div>
        {numbers.map((number) => (
          <div
            key={number.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '10px 0',
              borderTop: '1px solid var(--line-soft)',
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13.5 }}>{number.displayPhone}</div>
              <div style={hint}>ID номера {number.phoneNumberId}</div>
              {/* The failure this line exists for: Meta took the number and delivers
                  nothing, which looks identical to working until a client writes. */}
              {!number.subscribed && (
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
                      try {
                        await api.disconnectWhatsappNumber(agentId, number.id);
                        toast.ok('Номер отключён');
                        onChanged();
                      } catch (error) {
                        toast.fail(error);
                      }
                    }}
                  >
                    Отключить
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
      </Card>
    );
  }

  function WebhookCard({ setup }: { setup: WebhookSetup }) {
    return (
      <Card>
        <div style={{ fontSize: 13.5, fontWeight: 650, marginBottom: 8 }}>Вебхук в Meta</div>
        <div style={hint}>
          Вставьте это в настройках приложения Meta: WhatsApp → Configuration → Webhook. Затем
          подпишитесь на поле messages.
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

  function ConnectForm({
    agentId,
    onConnected,
  }: {
    agentId: string;
    onConnected: () => void;
  }) {
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
          <div style={{ fontSize: 13.5, fontWeight: 650 }}>Подключить номер WhatsApp</div>
          <div style={hint}>
            Значения берутся в Meta: WhatsApp → API Setup. Токен — постоянный, от системного
            пользователя.
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
}
```

- [ ] **Step 3: Route the section to it**

In `rakurs/src/App.tsx`, import `IntegrationsScreen` and extend the element chosen per section
so `integrations` renders it, the way `settings` already renders its own screen. In
`rakurs/src/lib/sections.ts`, set the `integrations` entry's `pending` to `''` — the section is
real now. Leave the other five untouched.

- [ ] **Step 4: Check the gates**

```bash
npm --prefix rakurs run typecheck
npm --prefix rakurs run build
```

Expected: PASS.

- [ ] **Step 5: Look at it**

With both dev servers running, open Интеграции as the owner. The form is there, the webhook
card shows the address built from `PUBLIC_URL`, and a made-up token produces a red toast
carrying Meta's own words rather than a blank screen. Demote yourself to `member` in the
development database, reload, and confirm the form and the webhook card are gone.

- [ ] **Step 6: Commit**

```bash
git add -A rakurs
git commit -m "Connect a WhatsApp number from the integrations screen"
```
