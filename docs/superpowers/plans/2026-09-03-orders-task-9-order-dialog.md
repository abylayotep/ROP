### Task 9 — the order dialog

This is step 1 of [task 9](2026-09-03-orders-task-9-lead-panel.md). It lives in its own
document so that neither crosses the five-hundred-line limit this repository keeps. Copy it
verbatim; the values in it are the task's requirements.

Create `rakurs/src/components/lead/OrderDialog.tsx`:

```tsx
import { useState, type CSSProperties, type FormEvent } from 'react';
import * as api from '@/api';
import { useToast } from '@/components/ui/Toast';
import type { Lead, Order } from '@/types';

/**
 * Форма заказа: сумма, статус, комментарий.
 *
 * Открывается из карточки лида и при переводе лида в стадию продажи. Закрыть, ничего
 * не заполнив, — нормальный исход: лид останется в продаже без заказа, воронка посчитает
 * конверсию, а деньги останутся нулевыми. Придуманная сумма ушла бы дальше в Meta.
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
 * До двенадцати цифр и не больше двух знаков после точки — форма колонки numeric(14,2).
 * Проверяем здесь той же меркой, что и сервер, чтобы отказ читался на месте, а не
 * приходил ошибкой запроса.
 */
const AMOUNT = /^\d{1,12}([.,]\d{1,2})?$/;

export function OrderDialog({
  agentId,
  conversationId,
  currency,
  order,
  onClose,
  onSaved,
}: {
  agentId: string;
  conversationId: string;
  currency: string;
  /** Заполнено — правим существующий заказ; null — заводим новый. */
  order: Order | null;
  onClose: () => void;
  onSaved: (lead: Lead) => void;
}) {
  const toast = useToast();
  const [amount, setAmount] = useState(order?.amount ?? '');
  const [status, setStatus] = useState<Order['status']>(order?.status ?? 'paid');
  const [comment, setComment] = useState(order?.comment ?? '');
  const [saving, setSaving] = useState(false);

  const valid = AMOUNT.test(amount.trim());

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!valid) return;

    // Запятая — то, как сумму набирают на русской раскладке. Сервер её не примет,
    // поэтому меняем на точку здесь, а не отказываем человеку в вводе.
    const normalised = amount.trim().replace(',', '.');

    setSaving(true);
    try {
      const lead = order
        ? await api.updateOrder(agentId, order.id, { amount: normalised, status, comment })
        : await api.createOrder(agentId, conversationId, {
            amount: normalised,
            status: status === 'cancelled' ? 'pending' : status,
            comment,
          });
      onSaved(lead);
    } catch (error) {
      toast.fail(error);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={backdrop} onClick={onClose}>
      <form
        onSubmit={save}
        onClick={(event) => event.stopPropagation()}
        className="card card-pad"
        style={{ width: 380, maxWidth: '100%', display: 'flex', flexDirection: 'column', gap: 14 }}
      >
        <div style={{ fontSize: 13.5, fontWeight: 650 }}>
          {order ? 'Заказ' : 'Новый заказ'}
        </div>

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
            {/* Отмену предлагаем только у существующего заказа: заводить сразу
                отменённый заказ незачем. */}
            {order && <option value="cancelled">Отменён</option>}
          </select>
        </div>

        <div>
          <div style={label}>Комментарий</div>
          <input
            style={control}
            value={comment}
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
```
