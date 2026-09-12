import { useEffect, useState, type FormEvent } from 'react';
import QRCode from 'qrcode';
import * as api from '@/api';
import * as kaspi from '@/api/kaspi';
import { useToast } from '@/components/ui/Toast';
import type { Lead, Order } from '@/types';

export function OrderDialog({ agentId, conversationId, currency, order, onClose, onSaved }: {
  agentId: string; conversationId: string; currency: string; order: Order | null; existingOrders: number;
  onClose: () => void; onSaved: (lead: Lead) => void;
}) {
  const toast = useToast();
  const [amount, setAmount] = useState(order?.amount ?? '');
  const [phone, setPhone] = useState('');
  const [comment, setComment] = useState(order?.comment ?? '');
  const [method, setMethod] = useState<'invoice' | 'qr'>('invoice');
  const [payment, setPayment] = useState<kaspi.KaspiPayment | null>(null);
  const [requestKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [qr, setQr] = useState('');
  useEffect(() => {
    let live = true;
    void api.getLead(agentId, conversationId).then((lead) => { if (live) setPhone((current) => current || lead.contactPhone); }).catch(toast.fail);
    void kaspi.getKaspiPayments(agentId, conversationId).then(({ payments }) => {
      if (live) setPayment((order ? payments.find((p) => p.orderId === order.id) : payments.find((p) => ['creating', 'unknown', 'pending'].includes(p.status))) ?? null);
    }).catch(toast.fail).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [agentId, conversationId, order?.id]);
  useEffect(() => {
    if (!payment?.qrToken) { setQr(''); return; }
    void QRCode.toDataURL(payment.qrToken, { width: 260, margin: 2 }).then(setQr).catch(toast.fail);
  }, [payment?.qrToken]);
  useEffect(() => {
    if (payment?.status !== 'pending') return;
    const timer = setInterval(() => { void kaspi.checkKaspiPayment(agentId, payment.id).then(setPayment).catch(() => {}); }, 5000);
    return () => clearInterval(timer);
  }, [agentId, payment?.id, payment?.status]);
  async function save(e: FormEvent) {
    e.preventDefault(); if (busy || loading) return; setBusy(true);
    try {
      if (order) { onSaved(await api.updateOrder(agentId, order.id, { comment })); }
      else setPayment(await kaspi.createKaspiPayment(agentId, { conversationId, amount: amount.trim().replace(',', '.'), phone, comment, method, requestKey }));
    } catch (error) { toast.fail(error); } finally { setBusy(false); }
  }
  async function finish() { try { onSaved(await api.getLead(agentId, conversationId)); } catch (error) { toast.fail(error); } }
  const field = { display: 'block', width: '100%', marginTop: 6, padding: 10, background: 'var(--sunken)', color: 'var(--text)', border: '1px solid var(--line)', borderRadius: 8 };
  const statusText: Record<string, string> = { creating: 'Выставляем счёт…', pending: 'Ожидаем подтверждения оплаты от Kaspi', paid: 'Kaspi подтвердил оплату', unknown: 'Результат выставления неизвестен', expired: 'Срок счёта истёк', failed: 'Kaspi отклонил оплату' };
  return <div style={{ position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(0,0,0,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }} onMouseDown={(e) => { if (e.target === e.currentTarget) void finish(); }}>
    <form className="card card-pad" onSubmit={save} style={{ width: 400, maxWidth: '100%', maxHeight: '90vh', overflow: 'auto', display: 'grid', gap: 14 }}>
      <strong>{order ? 'Заказ' : 'Выставить счёт Kaspi'}</strong>
      {loading ? <p>Проверяем счета…</p> : payment ? <>
        <strong>{statusText[payment.status] ?? payment.status}</strong>
        <p>{payment.amount} ₸{payment.phone ? ` · ${payment.phone}` : ''}</p>
        {payment.error && <p role="alert">{payment.error}</p>}
        {qr && payment.status === 'pending' && <img src={qr} width={260} height={260} alt="QR для оплаты в Kaspi" />}
        {payment.paymentUrl && payment.status === 'pending' && <a href={payment.paymentUrl} target="_blank" rel="noreferrer">Открыть оплату в Kaspi</a>}
        {payment.operationId && <small>Номер операции: {payment.operationId}</small>}
        {payment.status === 'pending' && <button type="button" className="btn" disabled={busy} onClick={() => { setBusy(true); void kaspi.checkKaspiPayment(agentId, payment.id).then(setPayment).catch(toast.fail).finally(() => setBusy(false)); }}>Проверить оплату</button>}
        {payment.method === 'invoice' && payment.status === 'pending' && <button type="button" className="btn-quiet" disabled={busy} onClick={() => { setBusy(true); void kaspi.createKaspiPayment(agentId, { conversationId, amount: payment.amount, phone: '', comment, method: 'qr', requestKey: `qr:${payment.id}` }).then(setPayment).catch(toast.fail).finally(() => setBusy(false)); }}>Клиент попросил QR — отменить счёт и создать QR</button>}
        <button type="button" className="btn-quiet" onClick={() => void finish()}>Готово</button>
      </> : <>
        {!order && <>
          <label>Сумма, {currency}<input style={field} value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" required /></label>
          <label>Способ оплаты<select style={field} value={method} onChange={(e) => setMethod(e.target.value as 'invoice' | 'qr')}><option value="invoice">Счёт на телефон</option><option value="qr">QR — клиент попросил</option></select></label>
          {method === 'invoice' && <label>Телефон клиента<input style={field} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+7 701 123 45 67" type="tel" required /></label>}
          <small>Заказ станет оплаченным только после подтверждения Kaspi.</small>
        </>}
        <label>Комментарий<input style={field} value={comment} maxLength={500} onChange={(e) => setComment(e.target.value)} /></label>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}><button type="button" className="btn-quiet" onClick={onClose}>Не сейчас</button><button className="btn" disabled={busy || loading}>{busy ? 'Отправляем…' : order ? 'Сохранить комментарий' : 'Выставить счёт'}</button></div>
      </>}
    </form>
  </div>;
}
