import { useEffect, useState } from 'react';
import * as api from '@/api';
import { ErrorState, Skeleton } from '@/components/ui/states';
import { useApi } from '@/hooks/useApi';
import type { OperatorNotifySettings } from '@/types';

/** The stored digits as a person reads a number; the server normalizes whatever comes back. */
export const operatorPhoneDisplay = (phone: string | null): string => (phone ? `+${phone}` : '');

type NotifyUpdate = (agentId: string, phone: string) => Promise<OperatorNotifySettings>;

export const saveOperatorNotify = (
  agentId: string,
  phone: string,
  update: NotifyUpdate = api.updateOperatorNotify,
) => update(agentId, phone.trim());

/**
 * Where the handoff alert goes. Members see the number; only the owner may change it, and the
 * server enforces the same split.
 */
export function OperatorNotifyCard({
  agentId,
  readOnly = false,
}: {
  agentId: string;
  readOnly?: boolean;
}) {
  const source = useApi((signal) => api.getOperatorNotify(agentId, signal), [agentId]);
  const [saved, setSaved] = useState<OperatorNotifySettings | undefined>(source.data);
  const [value, setValue] = useState(operatorPhoneDisplay(source.data?.phone ?? null));
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    if (!source.data) return;
    setSaved(source.data);
    setValue(operatorPhoneDisplay(source.data.phone));
  }, [source.data]);

  const unchanged = saved !== undefined && value.trim() === operatorPhoneDisplay(saved.phone);

  async function save() {
    if (readOnly || saving || unchanged) return;
    setSaving(true);
    setSaveMessage(null);
    try {
      const next = await saveOperatorNotify(agentId, value);
      setSaved(next);
      setValue(operatorPhoneDisplay(next.phone));
      setSaveMessage({ kind: 'ok', text: next.phone ? 'Номер сохранён' : 'Уведомления выключены' });
    } catch (error) {
      setSaveMessage({ kind: 'error', text: api.humanError(error) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="operator-notify" aria-labelledby="operator-notify-title">
      <div className="knowledge-panel-head">
        <div>
          <p className="knowledge-kicker">Передача человеку</p>
          <h2 id="operator-notify-title">Уведомления оператору</h2>
        </div>
      </div>

      {source.data === undefined && source.error === undefined && (
        <div className="operator-notify__loading" role="status" aria-label="Загружаем номер оператора">
          <Skeleton height={36} />
        </div>
      )}
      {source.data === undefined && source.error !== undefined && (
        <ErrorState error={source.error} onRetry={source.reload} compact />
      )}
      {saved && (
        <form
          className="operator-notify__form"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label className="operator-notify__label" htmlFor={`operator-notify-${agentId}`}>
            Номер WhatsApp оператора
          </label>
          <input
            id={`operator-notify-${agentId}`}
            className="knowledge-control"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="+7 771 694 44 99"
            value={value}
            disabled={readOnly || saving}
            onChange={(event) => setValue(event.target.value)}
          />
          <p className="operator-notify__note">
            Когда агент передаёт диалог человеку, на этот номер придёт сообщение: кто клиент, что хочет и срочно ли.
            Сообщение отправляется с номера, на который написал клиент. Для номера через Meta Cloud API оно дойдёт,
            только если оператор писал этому номеру за последние 24 часа.
          </p>
          {!readOnly && (
            <button type="submit" className="btn-accent operator-notify__save" disabled={saving || unchanged}>
              {saving ? 'Сохраняем…' : 'Сохранить номер'}
            </button>
          )}
          {saveMessage && (
            <p
              className={`operator-notify__message operator-notify__message--${saveMessage.kind}`}
              role={saveMessage.kind === 'error' ? 'alert' : 'status'}
            >
              {saveMessage.text}
            </p>
          )}
        </form>
      )}
    </section>
  );
}
