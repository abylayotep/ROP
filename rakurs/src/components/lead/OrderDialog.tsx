import { useState, type CSSProperties, type FormEvent } from 'react';
import * as api from '@/api';
import { useToast } from '@/components/ui/Toast';
import type { Lead, Order } from '@/types';

/**
 * The order form: amount, status, comment.
 *
 * Opened from the lead card and when a lead is moved into the sale stage. Closing it
 * without filling anything in is a normal outcome: the lead stays in the sale with no
 * order, the funnel counts the conversion, and the money stays zero. An invented amount
 * would travel on into Meta.
 */

const backdrop: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 90,
  background: 'rgba(0,0,0,0.45)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 20,
};

const control: CSSProperties = {
  width: '100%',
  padding: '9px 11px',
  marginTop: 5,
  background: 'var(--sunken)',
  color: 'var(--text)',
  border: '1px solid var(--line)',
  borderRadius: 8,
  font: 'inherit',
  fontSize: 13,
  outline: 'none',
};

const label: CSSProperties = { fontSize: 11.5, color: 'var(--text-dim)' };

/**
 * A comma is how an amount is typed on a Russian keyboard layout, and leading zeros are
 * what editing an already-typed number leaves behind. The server accepts neither, so we
 * convert here instead of refusing what the person typed.
 */
const normalise = (raw: string) => raw.trim().replace(',', '.').replace(/^0+(?=\d)/, '');

/**
 * Up to twelve digits and no more than two after the point — the shape of a numeric(14,2)
 * column. Measured against the normalised string, not the raw one, so the form is not
 * stricter than the server: `0000000000001` is a valid `1`.
 */
const AMOUNT = /^\d{1,12}(\.\d{1,2})?$/;

/** The server's limit on an order comment. */
const COMMENT_MAX = 500;

export function OrderDialog({
  agentId,
  conversationId,
  currency,
  order,
  existingOrders,
  onClose,
  onSaved,
}: {
  agentId: string;
  conversationId: string;
  currency: string;
  /** Set — we are editing an existing order; null — creating a new one. */
  order: Order | null;
  /** How many orders the lead already carries. Shown when creating another one. */
  existingOrders: number;
  onClose: () => void;
  onSaved: (lead: Lead) => void;
}) {
  const toast = useToast();
  const [amount, setAmount] = useState(order?.amount ?? '');
  const [status, setStatus] = useState<Order['status']>(order?.status ?? 'paid');
  const [comment, setComment] = useState(order?.comment ?? '');
  const [saving, setSaving] = useState(false);

  const normalised = normalise(amount);
  const valid = AMOUNT.test(normalised);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!valid || saving) return;

    setSaving(true);
    try {
      let lead: Lead;
      if (order) {
        lead = await api.updateOrder(agentId, order.id, { amount: normalised, status, comment });
      } else if (status !== 'cancelled') {
        lead = await api.createOrder(agentId, conversationId, {
          amount: normalised,
          status,
          comment,
        });
      } else {
        // Unreachable: cancellation is only offered once the order exists. Checked rather
        // than mapped onto another status, because recording a status nobody chose would
        // be worse than doing nothing.
        return;
      }
      onSaved(lead);
    } catch (error) {
      toast.fail(error);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      style={backdrop}
      // Closed on the press, and only when the press lands on the backdrop itself.
      // Closing on `click` would also fire when a selection that began inside the form
      // ended out here, throwing away a typed amount.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <form
        onSubmit={save}
        className="card card-pad"
        style={{ width: 380, maxWidth: '100%', display: 'flex', flexDirection: 'column', gap: 14 }}
      >
        <div style={{ fontSize: 13.5, fontWeight: 650 }}>
          {order ? 'Заказ' : 'Новый заказ'}
        </div>

        {/* A repeat purchase is a second order, not an edit of the first — that is the whole
            reason orders live apart from the stage. Said out loud so nobody assumes the form
            opened by mistake and closes it. */}
        {!order && existingOrders > 0 && (
          <div style={{ fontSize: 11.5, color: 'var(--text-dim)', marginTop: -6 }}>
            У этого лида уже есть заказы. Этот будет ещё одним.
          </div>
        )}

        <div>
          <div style={label}>Сумма, {currency}</div>
          <input
            style={control}
            value={amount}
            autoFocus
            inputMode="decimal"
            placeholder="450000"
            onChange={(e) => setAmount(e.target.value)}
          />
          {amount.trim() !== '' && !valid && (
            <div style={{ fontSize: 11, color: 'var(--danger)', marginTop: 5 }}>
              Только цифры, максимум две после точки.
            </div>
          )}
        </div>

        <div>
          <div style={label}>Статус</div>
          <select
            style={control}
            value={status}
            onChange={(e) => setStatus(e.target.value as Order['status'])}
          >
            <option value="paid">Оплачен</option>
            <option value="pending">Ожидает оплаты</option>
            {/* Cancellation is offered only for an order that exists: there is no reason
                to create one already cancelled. */}
            {order && <option value="cancelled">Отменён</option>}
          </select>
        </div>

        <div>
          <div style={label}>Комментарий</div>
          <input
            style={control}
            value={comment}
            maxLength={COMMENT_MAX}
            placeholder="Что купили"
            onChange={(e) => setComment(e.target.value)}
          />
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="btn-quiet" onClick={onClose}>
            {order ? 'Отмена' : 'Не сейчас'}
          </button>
          <button type="submit" className="btn" disabled={!valid || saving}>
            {saving ? 'Сохраняем…' : 'Сохранить'}
          </button>
        </div>
      </form>
    </div>
  );
}
