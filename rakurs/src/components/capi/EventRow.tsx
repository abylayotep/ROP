import { useState } from 'react';
import * as api from '@/api';
import { Badge } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/Toast';
import { formatMoney } from '@/lib/money';
import type { CapiEvent } from '@/types';

/**
 * One line of the report log, shown both on Integrations and on the lead card.
 *
 * Shared rather than written twice because both places answer the owner's one question —
 * «ушла ли эта продажа в Meta, и если нет, почему» — and two answers to it in two corners
 * of the cabinet are two answers, one of which is wrong.
 */

const KIND: Record<string, string> = { purchase: 'Покупка', lead: 'Заявка' };

interface StatusLook {
  text: string;
  bg: string;
  fg: string;
}

/**
 * Четыре состояния строки словами владельца.
 *
 * «В очереди» — не ошибка: очередь разбирается на каждом входящем сообщении и раз в
 * минуту по таймеру, так что продажа уходит примерно за минуту даже на тихом номере.
 * «Не отправлено» — решение кабинета, а не отказ Meta: набор данных выключен, не настроен
 * или диалог пришёл не из рекламы. Причина лежит в `error` и печатается целиком.
 */
const STATUS: Record<string, StatusLook> = {
  pending: { text: 'В очереди', bg: 'var(--warn-a14)', fg: 'var(--warn)' },
  sent: { text: 'Отправлено', bg: 'var(--accent-a14)', fg: 'var(--accent)' },
  failed: { text: 'Meta отказала', bg: 'var(--danger-a14)', fg: 'var(--danger)' },
  skipped: { text: 'Не отправлено', bg: 'var(--line-2)', fg: 'var(--text-3)' },
};

const UNKNOWN: StatusLook = { text: 'Неизвестно', bg: 'var(--line-2)', fg: 'var(--text-3)' };

const when = (iso: string) =>
  new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

/**
 * A resend is offered only where it changes something: a report Meta refused, or one the
 * cabinet held back for a reason an owner has since fixed. `resendable` is the server's
 * own answer about whether there is anything to send at all — a conversation that did not
 * come from an ad has no click identifier, and the route refuses that row.
 */
const canResend = (event: CapiEvent) =>
  event.resendable && (event.status === 'failed' || event.status === 'skipped');

export function CapiEventRow({
  agentId,
  event,
  who = true,
  onResent,
}: {
  agentId: string;
  event: CapiEvent;
  /** The contact's name and phone. Off on the lead card, where they are already above. */
  who?: boolean;
  /** The row the server answered with, which replaces this one. */
  onResent: (event: CapiEvent) => void;
}) {
  const toast = useToast();
  const [sending, setSending] = useState(false);

  const look = STATUS[event.status] ?? UNKNOWN;
  const amount = event.value !== null && event.currency !== null;

  async function resend() {
    if (sending) return;
    setSending(true);
    try {
      // The route answers with the whole row as it now stands, and that is what goes on
      // screen: a row we edited ourselves would claim a state the server never wrote.
      onResent(await api.resendCapiEvent(agentId, event.id));
      toast.ok('Событие поставлено в очередь');
    } catch (error) {
      // A row with nothing to send answers 409 with the sentence that says why. The toast
      // shows the server's own words, which are the answer the owner came for.
      toast.fail(error);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="sunken-box" style={{ padding: '9px 11px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontSize: 12.5, fontWeight: 650 }}>{KIND[event.kind] ?? event.kind}</span>
        {amount && (
          <span className="mono" style={{ fontSize: 12.5, fontWeight: 700 }}>
            {formatMoney(event.value!, event.currency!)}
          </span>
        )}
        <span style={{ marginLeft: 'auto' }}>
          <Badge bg={look.bg} fg={look.fg} size="row">
            {look.text}
          </Badge>
        </span>
      </div>

      <div style={{ fontSize: 10.5, color: 'var(--text-dim)', marginTop: 3 }}>
        {who && (event.contactName ?? event.contactPhone ?? 'Клиент удалён')}
        {who && ' · '}
        {/* When it was sent, if it was; otherwise when the cabinet decided to report it. */}
        {event.sentAt ? `отправлено ${when(event.sentAt)}` : when(event.createdAt)}
        {event.attempts > 0 && ` · попыток: ${event.attempts}`}
      </div>

      {/* Meta's reason in full, in Meta's own English where it is Meta's. Cutting it would
          take away the half an owner can act on — «Invalid access token» is the answer. */}
      {event.error && (
        <div
          style={{
            fontSize: 11,
            color: event.status === 'failed' ? 'var(--danger)' : 'var(--text-3)',
            marginTop: 5,
            lineHeight: 1.45,
            whiteSpace: 'pre-wrap',
          }}
        >
          {event.error}
        </div>
      )}

      {canResend(event) && (
        <button
          type="button"
          className="btn-sm"
          style={{ marginTop: 7 }}
          disabled={sending}
          onClick={resend}
        >
          {sending ? 'Отправляем…' : 'Отправить снова'}
        </button>
      )}
    </div>
  );
}
